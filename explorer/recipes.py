"""Read-only public recipe access and validation for browser steering requests."""
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, ValidationError


API = os.environ.get("NEURONARY_API", "https://mcczbdcymyhzfputyqcr.supabase.co/functions/v1/api")


def public_get(path, **params):
    # Never fetch a URL supplied by the browser or send the user's publishing token.
    url = API.rstrip("/") + path + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise HTTPException(404 if exc.code == 404 else 502, "Public recipe service returned an error") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(502, "Could not read the public recipe service; try again later") from exc


def recipe_router(model):
    router = APIRouter(prefix="/api/recipes")

    @router.get("")
    def search(q: str = Query("", max_length=300), sort: Literal["top", "new", "hot"] = "top",
               offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=50)):
        return public_get("/recipes", q=q, sort=sort, offset=offset, limit=limit)

    @router.get("/{recipe_id}")
    def get_recipe(recipe_id: str):
        import re
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", recipe_id):
            raise HTTPException(422, "Invalid recipe ID")
        recipe = public_get("/recipes/" + recipe_id)
        try:
            recipe["steer_neurons"] = [Neuron.model_validate({"layer": n["layer"], "n": n["neuron"],
                                       "dose": n["dose"], "mode": n.get("mode", "add")}).model_dump()
                                       for n in recipe["neurons"]]
            if not recipe["steer_neurons"]:
                raise ValueError("Empty recipe")
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(502, "Public service returned an invalid recipe") from exc
        recipe["compatible"] = recipe.get("model") == model
        recipe["loaded_model"] = model
        return recipe

    return router


class Neuron(BaseModel):
    layer: int = Field(ge=0, strict=True)
    n: int = Field(ge=0, strict=True)
    dose: float = Field(allow_inf_nan=False)
    mode: Literal["add", "mul"] = "add"


class Turn(BaseModel):
    user: str = Field(min_length=1, max_length=100000)
    replies: list[str] = Field(min_length=3, max_length=3)


class SteeringRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=100000)
    neurons: list[Neuron] = Field(min_length=1, max_length=1024)
    history: list[Turn] = Field(default_factory=list, max_length=50)
    max_new: int = Field(default=300, ge=1, le=4096)
    temperature: float = Field(default=0, ge=0, le=10, allow_inf_nan=False)
    repetition_penalty: float = Field(default=1, gt=0, le=10, allow_inf_nan=False)
    seed: int = Field(default=0, ge=0, le=2**63 - 1)
    min_p: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    model: str | None = None


def validate_steering(body, arch, model):
    # Preserve the existing single-neuron Chat API.
    body = dict(body)
    if "neurons" not in body:
        body["neurons"] = [{"layer": body.get("layer"), "n": body.get("n"),
                            "dose": body.get("dose", 0.8), "mode": body.get("mode", "add")}]
    try:
        request = SteeringRequest.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    if request.model is not None and request.model != model:
        raise HTTPException(422, "Recipe model does not match the loaded model")
    seen = set()
    for neuron in request.neurons:
        key = (neuron.layer, neuron.n)
        if neuron.layer >= arch["n_layers"] or neuron.n >= arch["inter"]:
            raise HTTPException(422, "Recipe neuron is outside the loaded model architecture")
        if key in seen:
            raise HTTPException(422, "Recipe contains duplicate neurons")
        seen.add(key)
    return request
