"""Network configuration and access checks, independent of the model runtime."""
import base64
import binascii
import hmac
import logging
import os
from dataclasses import dataclass
from urllib.parse import urlsplit

from starlette.responses import PlainTextResponse

log = logging.getLogger("uvicorn.error")


def parse_origin(value):
    url = urlsplit(value)
    if (url.scheme not in ("http", "https") or not url.hostname or url.username is not None
            or url.password is not None or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("EXPLORER_PUBLIC_URL must be an http(s) origin without a path or credentials")
    # Accessing port also validates malformed port numbers.
    return url.scheme, url.hostname.lower(), url.port or (443 if url.scheme == "https" else 80)


@dataclass
class NetworkConfig:
    host: str
    port: int
    public_url: str
    password: str
    trust_proxy_headers: bool = False

    @classmethod
    def from_env(cls):
        port = int(os.environ.get("PORT", "8791"))
        pod = os.environ.get("RUNPOD_POD_ID")
        public_url = os.environ.get("EXPLORER_PUBLIC_URL", "").rstrip("/")
        if not public_url and pod:
            public_url = f"https://{pod}-{port}.proxy.runpod.net"
        host = os.environ.get("EXPLORER_HOST", "0.0.0.0" if pod else "127.0.0.1")
        password = os.environ.get("EXPLORER_PASSWORD", "")
        trust_proxy_headers = os.environ.get("EXPLORER_TRUST_PROXY_HEADERS", "1" if pod else "0") == "1"
        if not 1 <= port <= 65535:
            raise ValueError("PORT must be between 1 and 65535")
        if public_url:
            parse_origin(public_url)
        if host not in ("127.0.0.1", "localhost", "::1") or public_url or trust_proxy_headers:
            if not password:
                raise ValueError("Set EXPLORER_PASSWORD before enabling remote access (the agent can run shell commands)")
            if not public_url:
                raise ValueError("Set EXPLORER_PUBLIC_URL to the browser's external http(s) origin")
        return cls(host, port, public_url, password, trust_proxy_headers)

    @property
    def internal_url(self):
        return f"http://{'[::1]' if self.host == '::1' else '127.0.0.1'}:{self.port}"

    @property
    def agent_env(self):
        return {"EXPLORER_URL": self.internal_url, "EXPLORER_PASSWORD": self.password}

    async def protect(self, request, call_next):
        # Some proxies rewrite Host. Opt-in forwarded-host handling still requires
        # an exact configured authority AND authentication; it is not client identity.
        hosts = {f"localhost:{self.port}", f"127.0.0.1:{self.port}", f"[::1]:{self.port}"}
        origins = {("http", host, self.port) for host in ("localhost", "127.0.0.1", "::1")}
        public_hosts = set()
        if self.public_url:
            public_origin = parse_origin(self.public_url)
            origins.add(public_origin)
            public_hosts.add(urlsplit(self.public_url).netloc.lower())
            # Browsers/proxies may include or omit a scheme's default port.
            if public_origin[2] == (443 if public_origin[0] == "https" else 80):
                hostname = urlsplit(self.public_url).hostname
                authority = f"[{hostname}]" if ":" in hostname else hostname
                public_hosts.update((authority.lower(), f"{authority}:{public_origin[2]}".lower()))
            hosts.update(public_hosts)
        host = request.headers.get("host", "").lower()
        forwarded_host = request.headers.get("x-forwarded-host", "").strip().lower()
        valid_host = host in hosts or (self.trust_proxy_headers and self.password
                                      and forwarded_host in public_hosts)
        origin = request.headers.get("origin")
        try:
            valid_origin = not origin or parse_origin(origin) in origins
        except ValueError:
            valid_origin = False
        valid_fetch = not (request.headers.get("sec-fetch-site") in ("cross-site", "same-site")
                           and not (request.method == "GET" and request.headers.get("sec-fetch-mode") == "navigate"))
        if not valid_host or not valid_origin or not valid_fetch:
            reason = "host" if not valid_host else "origin" if not valid_origin else "fetch-metadata"
            # No Authorization, cookies, query parameters or passwords in diagnostics.
            log.warning("Explorer rejected request: reason=%s host=%r x-forwarded-host=%r origin=%r "
                        "sec-fetch-site=%r sec-fetch-mode=%r public_url=%r trust_proxy_headers=%s",
                        reason, host, forwarded_host, origin, request.headers.get("sec-fetch-site"),
                        request.headers.get("sec-fetch-mode"), self.public_url, self.trust_proxy_headers)
            return PlainTextResponse("forbidden", status_code=403)
        if self.password:
            try:
                scheme, data = request.headers.get("authorization", "").split(" ", 1)
                credentials = base64.b64decode(data, validate=True).decode("utf-8")
                valid = scheme.lower() == "basic" and hmac.compare_digest(
                    credentials.encode(), f"explorer:{self.password}".encode())
            except (ValueError, UnicodeError, binascii.Error):
                valid = False
            if not valid:
                return PlainTextResponse("authentication required", status_code=401,
                                         headers={"WWW-Authenticate": 'Basic realm="Neuron Explorer", charset="UTF-8"',
                                                  "Cache-Control": "no-store"})
        response = await call_next(request)
        if response.headers.get("content-type", "").startswith(("application/x-ndjson", "text/event-stream")):
            response.headers["X-Accel-Buffering"] = "no"
            response.headers["Cache-Control"] = "no-store"
        return response
