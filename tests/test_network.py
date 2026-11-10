import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from explorer.network import NetworkConfig
from explorer import agent_mcp


class NetworkTests(unittest.TestCase):
    def client(self, config, base_url):
        app = FastAPI()
        app.middleware("http")(config.protect)

        @app.api_route("/api/test", methods=["GET", "POST"])
        def endpoint():
            return {"ok": True}

        @app.get("/api/events")
        def events():
            return StreamingResponse(iter(['{"t":"ping"}\n']), media_type="application/x-ndjson")

        @app.get("/api/steer")
        def steer():
            return StreamingResponse(iter(['data: {}\n\n']), media_type="text/event-stream")

        return TestClient(app, base_url=base_url)

    def remote(self):
        return self.client(NetworkConfig("0.0.0.0", 8791, "https://pod-8791.proxy.runpod.net", "secret"),
                           "https://pod-8791.proxy.runpod.net")

    def test_local_defaults(self):
        with patch.dict("os.environ", {}, clear=True):
            config = NetworkConfig.from_env()
        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(self.client(config, "http://127.0.0.1:8791").get("/api/test").status_code, 200)

    def test_runpod_defaults(self):
        with patch.dict("os.environ", {"RUNPOD_POD_ID": "pod", "EXPLORER_PASSWORD": "secret", "PORT": "8888"}, clear=True):
            config = NetworkConfig.from_env()
        self.assertEqual(config.host, "0.0.0.0")
        self.assertEqual(config.public_url, "https://pod-8888.proxy.runpod.net")
        self.assertEqual(config.agent_env, {"EXPLORER_URL": "http://127.0.0.1:8888", "EXPLORER_PASSWORD": "secret"})

    def test_unsafe_configuration_rejected(self):
        for env in ({"EXPLORER_HOST": "0.0.0.0"},
                    {"EXPLORER_HOST": "0.0.0.0", "EXPLORER_PASSWORD": "secret"},
                    {"EXPLORER_PUBLIC_URL": "https://example.com"},
                    {"EXPLORER_PUBLIC_URL": "https://example.com/path", "EXPLORER_PASSWORD": "secret"}):
            with self.subTest(env=env), patch.dict("os.environ", env, clear=True), self.assertRaises(ValueError):
                NetworkConfig.from_env()

    def test_remote_authentication(self):
        client = self.remote()
        self.assertEqual(client.get("/api/test").status_code, 401)
        self.assertEqual(client.get("/api/test", auth=("explorer", "wrong")).status_code, 401)
        self.assertEqual(client.get("/api/test", headers={"Authorization": "Basic !!!"}).status_code, 401)
        self.assertEqual(client.get("/api/test", auth=("explorer", "secret")).status_code, 200)

    def test_same_origin_post_through_https_proxy(self):
        response = self.remote().post("/api/test", auth=("explorer", "secret"), headers={
            "Origin": "https://pod-8791.proxy.runpod.net", "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(response.status_code, 200)

    def test_foreign_origins_and_hosts_rejected(self):
        for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"},
                        {"Origin": "http://pod-8791.proxy.runpod.net"},
                        {"Host": "evil.example", "X-Forwarded-Host": "pod-8791.proxy.runpod.net"},
                        {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.remote().post("/api/test", auth=("explorer", "secret"),
                                                    headers=headers).status_code, 403)

    def test_external_navigation_allowed_but_authenticated(self):
        response = self.remote().get("/api/test", auth=("explorer", "secret"), headers={
            "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"})
        self.assertEqual(response.status_code, 200)

    def test_internal_agent_authenticated(self):
        config = NetworkConfig("0.0.0.0", 8791, "https://pod-8791.proxy.runpod.net", "secret")
        with patch.object(agent_mcp, "PASSWORD", "secret"):
            req = agent_mcp.explorer_request(config.internal_url + "/api/test")
        response = self.client(config, config.internal_url).get("/api/test", headers=dict(req.header_items()))
        self.assertEqual(response.status_code, 200)

    def test_stream_proxy_headers(self):
        response = self.remote().get("/api/events", auth=("explorer", "secret"))
        self.assertEqual(response.text, '{"t":"ping"}\n')
        self.assertEqual(response.headers["X-Accel-Buffering"], "no")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        response = self.remote().get("/api/steer", auth=("explorer", "secret"))
        self.assertEqual(response.headers["X-Accel-Buffering"], "no")


if __name__ == "__main__":
    unittest.main()
