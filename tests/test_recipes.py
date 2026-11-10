import copy
import unittest
import urllib.error
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from explorer.recipes import public_get, recipe_router, validate_steering


MODEL = "Qwen/Qwen3.5-4B"
ARCH = {"n_layers": 32, "inter": 9216}
RECIPE = {"id": "test123", "name": "Test", "model": MODEL, "neurons": [
    {"layer": 13, "neuron": 7956, "dose": -0.7}, {"layer": 14, "neuron": 8949, "dose": 0.7}],
    "sampling": {"temperature": 0.7, "repetition_penalty": 1.1}}


class RecipeTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(recipe_router(MODEL))
        self.client = TestClient(app)

    def test_search_and_pagination(self):
        with patch("explorer.recipes.public_get", return_value={"recipes": [RECIPE], "count": 21}) as get:
            response = self.client.get("/api/recipes?q=test&sort=new&offset=20&limit=20")
        self.assertEqual(response.status_code, 200)
        get.assert_called_once_with("/recipes", q="test", sort="new", offset=20, limit=20)

    def test_download_multineuron_recipe(self):
        with patch("explorer.recipes.public_get", return_value=copy.deepcopy(RECIPE)):
            response = self.client.get("/api/recipes/test123")
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertTrue(result["compatible"])
        self.assertEqual(result["sampling"], RECIPE["sampling"])
        self.assertEqual(result["steer_neurons"], [
            {"layer": 13, "n": 7956, "dose": -0.7, "mode": "add"},
            {"layer": 14, "n": 8949, "dose": 0.7, "mode": "add"}])

    def test_different_model_is_marked_incompatible(self):
        recipe = dict(RECIPE, model="other/model")
        with patch("explorer.recipes.public_get", return_value=recipe):
            result = self.client.get("/api/recipes/test123").json()
        self.assertFalse(result["compatible"])
        self.assertEqual(result["loaded_model"], MODEL)

    def test_invalid_recipe_rejected(self):
        with patch("explorer.recipes.public_get", return_value={"neurons": []}):
            self.assertEqual(self.client.get("/api/recipes/test123").status_code, 502)

    def test_invalid_search_and_id(self):
        with patch("explorer.recipes.public_get") as get:
            for path in ("/api/recipes?sort=bad", "/api/recipes?limit=1000", "/api/recipes?offset=-1", "/api/recipes/bad.id"):
                self.assertEqual(self.client.get(path).status_code, 422)
            get.assert_not_called()

    def test_upstream_errors(self):
        for error, code in ((OSError("offline"), 502),
                            (urllib.error.HTTPError("url", 404, "Not found", {}, None), 404)):
            with patch("explorer.recipes.urllib.request.urlopen", side_effect=error):
                with self.assertRaises(HTTPException) as caught:
                    public_get("/recipes/test")
            self.assertEqual(caught.exception.status_code, code)

    def test_public_requests_do_not_send_tokens(self):
        with patch("explorer.recipes.urllib.request.urlopen") as open_url:
            open_url.return_value.__enter__.return_value.read.return_value = b'{"recipes": []}'
            self.assertEqual(public_get("/recipes", q="a b"), {"recipes": []})
        url = open_url.call_args.args[0]
        self.assertIsInstance(url, str)
        self.assertTrue(url.endswith("/recipes?q=a+b"))

    def test_single_neuron_backwards_compatibility(self):
        request = validate_steering({"prompt": "Hello", "layer": 13, "n": 7956, "dose": 0.8}, ARCH, MODEL)
        self.assertEqual(len(request.neurons), 1)
        self.assertEqual(request.neurons[0].dose, 0.8)
        self.assertEqual(request.temperature, 0)

    def test_multi_turn_sampling(self):
        body = {"prompt": "Follow up", "neurons": [
            {"layer": 13, "n": 7956, "dose": -0.7}, {"layer": 14, "n": 8949, "dose": 0.7}],
            "history": [{"user": "Hello", "replies": ["recipe", "base", "reverse"]}],
            "temperature": 0.7, "min_p": 0.1, "seed": 42, "repetition_penalty": 1.1, "max_new": 100,
            "model": MODEL}
        result = validate_steering(body, ARCH, MODEL)
        self.assertEqual(result.history[0].replies, ["recipe", "base", "reverse"])
        self.assertEqual(result.neurons[0].dose, -0.7)
        self.assertEqual(result.seed, 42)

    def test_invalid_steering_rejected_before_generation(self):
        valid = {"prompt": "Hello", "neurons": [{"layer": 13, "n": 1, "dose": 0.8}]}
        for changes in ({"neurons": []}, {"model": "other/model"}, {"max_new": 0}, {"temperature": -1},
                        {"repetition_penalty": 0}, {"min_p": 2}, {"temperature": float("nan")},
                        {"neurons": [{"layer": 32, "n": 1, "dose": 0.8}]},
                        {"neurons": [{"layer": 1, "n": 9216, "dose": 0.8}]},
                        {"neurons": [{"layer": 1, "n": 1, "dose": float("inf")}]},
                        {"neurons": valid["neurons"] * 2},
                        {"history": [{"user": "Hello", "replies": ["one"]}]}):
            with self.subTest(changes=changes), self.assertRaises(HTTPException) as caught:
                validate_steering({**valid, **changes}, ARCH, MODEL)
            self.assertEqual(caught.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
