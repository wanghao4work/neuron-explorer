"""Network configuration and access checks, independent of the model runtime."""
import base64
import binascii
import hmac
import os
from dataclasses import dataclass
from urllib.parse import urlsplit

from starlette.responses import PlainTextResponse


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

    @classmethod
    def from_env(cls):
        port = int(os.environ.get("PORT", "8791"))
        pod = os.environ.get("RUNPOD_POD_ID")
        public_url = os.environ.get("EXPLORER_PUBLIC_URL", "").rstrip("/")
        if not public_url and pod:
            public_url = f"https://{pod}-{port}.proxy.runpod.net"
        host = os.environ.get("EXPLORER_HOST", "0.0.0.0" if pod else "127.0.0.1")
        password = os.environ.get("EXPLORER_PASSWORD", "")
        if not 1 <= port <= 65535:
            raise ValueError("PORT must be between 1 and 65535")
        if public_url:
            parse_origin(public_url)
        if host not in ("127.0.0.1", "localhost", "::1") or public_url:
            if not password:
                raise ValueError("Set EXPLORER_PASSWORD before enabling remote access (the agent can run shell commands)")
            if not public_url:
                raise ValueError("Set EXPLORER_PUBLIC_URL to the browser's external http(s) origin")
        return cls(host, port, public_url, password)

    @property
    def internal_url(self):
        return f"http://{'[::1]' if self.host == '::1' else '127.0.0.1'}:{self.port}"

    @property
    def agent_env(self):
        return {"EXPLORER_URL": self.internal_url, "EXPLORER_PASSWORD": self.password}

    async def protect(self, request, call_next):
        # Never trust forwarded Host headers from arbitrary clients. RunPod preserves
        # Host; its HTTPS origin is configured separately from the internal HTTP hop.
        hosts = {f"localhost:{self.port}", f"127.0.0.1:{self.port}", f"[::1]:{self.port}"}
        origins = {("http", host, self.port) for host in ("localhost", "127.0.0.1", "::1")}
        if self.public_url:
            origins.add(parse_origin(self.public_url))
            hosts.add(urlsplit(self.public_url).netloc.lower())
        origin = request.headers.get("origin")
        try:
            valid_origin = not origin or parse_origin(origin) in origins
        except ValueError:
            valid_origin = False
        if (request.headers.get("host", "").lower() not in hosts or not valid_origin
                or (request.headers.get("sec-fetch-site") in ("cross-site", "same-site")
                    and not (request.method == "GET" and request.headers.get("sec-fetch-mode") == "navigate"))):
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
