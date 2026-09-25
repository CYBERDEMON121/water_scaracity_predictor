import json
import math
import os
import pickle
import threading
import time
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from flask import Flask, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "model" / "water_model.pkl"
WATER_STRESS_URL = "https://api.worldbank.org/v2/country/all/indicator/ER.H2O.FWST.ZS?format=json&per_page=500&MRV=1"
WORLD_BANK_COUNTRIES_URL = "https://api.worldbank.org/v2/country?format=json&per_page=400"
WATER_STRESS_SOURCE = "https://data.worldbank.org/indicator/ER.H2O.FWST.ZS"
CACHE_SECONDS = 15 * 60
FEATURE_NAMES = ("rainfall", "population", "temperature", "water_usage")
INPUT_SCHEMA = {
    "rainfall": {"label": "Rainfall", "minimum": 0, "maximum": 5000, "integer": False},
    "population": {"label": "Population", "minimum": 0, "maximum": 2_000_000_000, "integer": True},
    "temperature": {"label": "Temperature", "minimum": -80, "maximum": 80, "integer": False},
    "water_usage": {"label": "Water usage", "minimum": 0, "maximum": 10000, "integer": False},
}
STRESS_LABELS = {
    "low": "Low pressure",
    "moderate": "Moderate pressure",
    "high": "High pressure",
    "extreme": "Extreme pressure",
}


class InputValidationError(ValueError):
    def __init__(self, errors):
        super().__init__("Invalid prediction input")
        self.errors = errors


class ModelUnavailableError(RuntimeError):
    pass


class Predictor:
    def __init__(self, model_path):
        self.model_path = model_path
        self.model = None
        self.lock = threading.Lock()

    def load(self):
        if self.model is not None:
            return self.model
        with self.lock:
            if self.model is None:
                if not self.model_path.exists():
                    raise ModelUnavailableError("The prediction model is missing")
                try:
                    with self.model_path.open("rb") as handle:
                        self.model = pickle.load(handle)
                except (ModuleNotFoundError, ImportError, OSError, pickle.PickleError) as error:
                    raise ModelUnavailableError("The prediction dependencies are unavailable") from error
        return self.model

    def status(self):
        try:
            self.load()
        except ModelUnavailableError:
            return {"available": False, "detail": "Install the runtime dependencies to enable predictions"}
        return {"available": True, "detail": "Scenario model ready"}

    def predict(self, values):
        model = self.load()
        features = np.asarray([[values[name] for name in FEATURE_NAMES]], dtype=float)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            label = model.predict(features)[0]
            probabilities = model.predict_proba(features)[0] if hasattr(model, "predict_proba") else []
        classes = [str(value) for value in getattr(model, "classes_", [])]
        probability_map = {
            classes[index]: round(float(probability) * 100, 1)
            for index, probability in enumerate(probabilities)
            if index < len(classes)
        }
        confidence = round(max(probability_map.values()), 1) if probability_map else None
        return {"prediction": str(label), "confidence": confidence, "probabilities": probability_map}


class WaterStressService:
    def __init__(self):
        self.cache = None
        self.cache_expires_at = 0
        self.lock = threading.Lock()

    @staticmethod
    def fetch_json(url):
        request = urllib.request.Request(url, headers={"User-Agent": "AquaPulse/1.0"})
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))

    @staticmethod
    def classify(value):
        if value < 10:
            return "low"
        if value < 25:
            return "moderate"
        if value < 100:
            return "high"
        return "extreme"

    def get(self, force=False):
        with self.lock:
            now = time.monotonic()
            if not force and self.cache is not None and self.cache_expires_at > now:
                return self.cache
            try:
                with ThreadPoolExecutor(max_workers=2) as executor:
                    indicator_future = executor.submit(self.fetch_json, WATER_STRESS_URL)
                    countries_future = executor.submit(self.fetch_json, WORLD_BANK_COUNTRIES_URL)
                    indicator_payload = indicator_future.result()
                    countries_payload = countries_future.result()
                self.cache = self.build_payload(indicator_payload, countries_payload)
                self.cache_expires_at = time.monotonic() + CACHE_SECONDS
                return self.cache
            except Exception:
                if self.cache is not None:
                    self.cache["stale"] = True
                    return self.cache
                raise

    @staticmethod
    def build_payload(indicator_payload, countries_payload):
        country_rows = countries_payload[1] if len(countries_payload) > 1 else []
        country_codes = {
            row["id"]
            for row in country_rows
            if row.get("id") and row.get("region", {}).get("id") != "NA"
        }
        indicator_rows = indicator_payload[1] if len(indicator_payload) > 1 else []
        countries = []
        for row in indicator_rows:
            iso3 = str(row.get("countryiso3code") or "").upper()
            value = row.get("value")
            if iso3 not in country_codes or value is None:
                continue
            try:
                numeric_value = float(value)
                year = int(row["date"])
            except (TypeError, ValueError, KeyError):
                continue
            if not math.isfinite(numeric_value) or numeric_value < 0:
                continue
            category = WaterStressService.classify(numeric_value)
            countries.append(
                {
                    "iso3": iso3,
                    "name": str(row.get("country", {}).get("value") or iso3),
                    "value": round(numeric_value, 2),
                    "year": year,
                    "category": category,
                    "label": STRESS_LABELS[category],
                }
            )
        if not countries:
            raise ValueError("The water-stress service returned no country observations")
        countries.sort(key=lambda item: item["value"], reverse=True)
        values = [item["value"] for item in countries]
        latest_year = max(item["year"] for item in countries)
        metadata = indicator_payload[0] if indicator_payload else {}
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "latest_year": latest_year,
            "source": {
                "provider": "World Bank World Development Indicators",
                "dataset": "AQUASTAT",
                "indicator": "ER.H2O.FWST.ZS",
                "last_updated": metadata.get("lastupdated"),
                "url": WATER_STRESS_SOURCE,
            },
            "summary": {
                "country_average": round(sum(values) / len(values), 1),
                "median": round(sorted(values)[len(values) // 2], 1),
                "reported": len(countries),
                "high_pressure": sum(item["category"] in {"high", "extreme"} for item in countries),
                "extreme_pressure": sum(item["category"] == "extreme" for item in countries),
            },
            "countries": countries,
            "stale": False,
        }


def parse_prediction_input(payload):
    if not isinstance(payload, dict):
        raise InputValidationError({"request": "Send a JSON object with the four scenario fields."})
    values = {}
    errors = {}
    for field, rules in INPUT_SCHEMA.items():
        raw_value = payload.get(field)
        if raw_value is None and field == "temperature":
            raw_value = payload.get("temp")
        if raw_value is None or raw_value == "":
            errors[field] = f"{rules['label']} is required."
            continue
        if isinstance(raw_value, bool):
            errors[field] = f"{rules['label']} must be a number."
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            errors[field] = f"{rules['label']} must be a number."
            continue
        if not math.isfinite(value):
            errors[field] = f"{rules['label']} must be finite."
            continue
        if rules["integer"] and not value.is_integer():
            errors[field] = f"{rules['label']} must be a whole number."
            continue
        if value < rules["minimum"] or value > rules["maximum"]:
            errors[field] = f"{rules['label']} must be between {rules['minimum']} and {rules['maximum']}."
            continue
        values[field] = value
    if errors:
        raise InputValidationError(errors)
    return values


def create_app():
    app = Flask(__name__)
    predictor = Predictor(MODEL_PATH)
    water_stress = WaterStressService()

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/health")
    def health():
        model_status = predictor.status()
        return jsonify({"status": "ok" if model_status["available"] else "degraded", "model": model_status})

    @app.get("/api/water-stress")
    def water_stress_data():
        try:
            return jsonify(water_stress.get(request.args.get("refresh") == "1"))
        except Exception:
            return jsonify(
                {
                    "error": "Water-stress data is temporarily unavailable.",
                    "detail": "The map will retry when the data service is reachable.",
                }
            ), 503

    @app.post("/api/predict")
    def predict():
        payload = request.get_json(silent=True)
        if payload is None:
            payload = request.form.to_dict()
        try:
            values = parse_prediction_input(payload)
            result = predictor.predict(values)
        except InputValidationError as error:
            return jsonify({"error": "Check the highlighted fields.", "fields": error.errors}), 400
        except ModelUnavailableError as error:
            return jsonify({"error": str(error), "code": "model_unavailable"}), 503
        except Exception:
            return jsonify({"error": "The scenario could not be evaluated."}), 500
        result["disclaimer"] = "Illustrative scenario estimate from the bundled demonstration model; not operational planning advice."
        return jsonify(result)

    return app


app = create_app()


if __name__ == "__main__":
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "0") == "1",
    )
