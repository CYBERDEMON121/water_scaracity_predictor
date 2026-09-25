# AquaPulse

AquaPulse is a Flask water-stress explorer with an animated dashboard, an interactive global country map, and a small scenario predictor. It visualizes the latest available country-level water-stress observations and estimates a scarcity class for user-supplied local conditions.

## Features

- Responsive dark-mode interface with animated counters, reveal effects, hover states, and accessible controls.
- Leaflet world map with country search, stress filters, hover tooltips, country readouts, and a responsive legend.
- World Bank World Development Indicators integration for `ER.H2O.FWST.ZS`, the level of water stress.
- Local clock showing the viewer’s current time.
- Scenario form for rainfall, population, temperature, and water usage.
- JSON prediction API with validation, confidence scores, and class probabilities.
- Model loading is lazy and model paths are resolved independently of the current working directory.
- Development server defaults to debug mode off.

## Requirements

- Python 3.11 or newer
- Internet access for the World Bank API, Leaflet assets, map tiles, and country boundaries

## Quick start

```bash
python -m venv .venv
```

Activate the environment:

```bash
source .venv/bin/activate
```

On Windows PowerShell:

```powershell
.venv\Scripts\Activate.ps1
```

Install dependencies and start the app:

```bash
python -m pip install -r requirements.txt
python app.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000).

The included `water/` directory is an old, non-portable virtual environment. Create a fresh `.venv` for your operating system instead of using it.

## Configuration

The app reads these optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `5000` | Server port |
| `FLASK_DEBUG` | `0` | Set to `1` only for local debugging |

Example:

```bash
HOST=0.0.0.0 PORT=8080 python app.py
```

## API

### Health

```bash
curl http://127.0.0.1:5000/api/health
```

### Water-stress map data

```bash
curl http://127.0.0.1:5000/api/water-stress
```

The response contains country ISO codes, names, values, observation years, display categories, source metadata, and summary counts. Results are cached in the Flask process for 15 minutes. Use `?refresh=1` to request a fresh copy from the World Bank:

```bash
curl "http://127.0.0.1:5000/api/water-stress?refresh=1"
```

### Scenario prediction

```bash
curl -X POST http://127.0.0.1:5000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"rainfall":200,"population":1000,"temperature":25,"water_usage":100}'
```

The endpoint validates finite numeric values, rejects negative or implausibly large inputs, and returns the predicted class, confidence, and class probabilities.

## Water-stress data

The map uses the World Bank indicator [`ER.H2O.FWST.ZS`](https://data.worldbank.org/indicator/ER.H2O.FWST.ZS), sourced from AQUASTAT. It measures freshwater withdrawal as a proportion of available renewable freshwater resources after environmental requirements are considered. Values can exceed 100% when withdrawals include non-renewable groundwater or reused water.

The application labels the data as the **latest available** observation rather than a live reading. The current World Bank response may contain 2022 observations even when the source metadata is updated more recently. Countries without an observation are shown in gray. The map is country-level; it does not claim subnational or household water-access measurements.

The interface uses these display bands:

- Low: below 10%
- Moderate: 10% to below 25%
- High: 25% to below 100%
- Extreme: 100% and above

These bands are presentation thresholds used by this demo, not a universal official classification.

## Model limitations

`model/water_model.pkl` is a demonstration `RandomForestClassifier` created from six synthetic records in `create_model.py`. It has not been trained or evaluated against a representative real-world dataset. Its predictions are illustrative only and must not be used for operational planning, public policy, or emergency decisions.

To experiment with the training script, install its additional dependency:

```bash
python -m pip install pandas
python create_model.py
```

Retraining overwrites the existing artifact, so use a separate model path and validate any replacement before deploying it.

## Project structure

```text
app.py                         Flask application and JSON APIs
create_model.py                Synthetic model-training script
model/water_model.pkl          Demonstration classifier
templates/index.html            Dashboard and application shell
static/css/style.css            Responsive visual design and animations
static/js/app.js                Map, clock, API, and form interactions
requirements.txt                Runtime dependencies
data/                           Reserved for future datasets
```

## Production notes

`python app.py` starts Flask’s development server and is intended for local exploration. For deployment, use a production WSGI server or platform, configure a reverse proxy, restrict outbound network access as needed, and review the World Bank and map-provider terms. The map uses OpenStreetMap tiles and publicly hosted Leaflet/country-boundary assets, so an internet connection is required at runtime.

## Troubleshooting

### `ModuleNotFoundError: No module named 'sklearn'`

Activate `.venv` and install `requirements.txt` again:

```bash
python -m pip install -r requirements.txt
```

### The map is blank

Check that the browser can reach Leaflet, the country GeoJSON source, and OpenStreetMap tiles. The map visualization requires external network access even though the Flask application itself is local.

### The prediction endpoint returns HTTP 503

The model artifact could not be loaded. Confirm that the virtual environment is active and that `model/water_model.pkl` is present. The map and dashboard remain available when the demonstration model is unavailable.
