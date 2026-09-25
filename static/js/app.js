"use strict";

const MAP_DATA_URL = "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson";
const MAP_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const CATEGORY_COLORS = {
    low: "#53e0c2",
    moderate: "#f5c96b",
    high: "#ff846c",
    extreme: "#f15ca7",
};
const state = {
    map: null,
    layerGroup: null,
    countryLayers: new Map(),
    countries: [],
    records: new Map(),
    geoJson: null,
    filter: "all",
    selectedIso: null,
};

const select = (selector) => document.querySelector(selector);
const selectAll = (selector) => Array.from(document.querySelectorAll(selector));

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
    }[character]));
}

function formatNumber(value) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value) {
    return Number(value).toFixed(1);
}

function setDataStatus(message, tone = "normal") {
    const status = select("#data-status");
    status.textContent = message;
    status.style.color = tone === "error" ? "var(--coral)" : "";
}

function animateNumber(element, target, formatter = formatNumber) {
    if (!element) {
        return;
    }
    const numericTarget = Number(target);
    if (!Number.isFinite(numericTarget)) {
        element.textContent = "—";
        return;
    }
    const start = performance.now();
    const duration = 850;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
        element.textContent = formatter(numericTarget);
        return;
    }
    const tick = (now) => {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        element.textContent = formatter(numericTarget * eased);
        if (progress < 1) {
            window.requestAnimationFrame(tick);
        }
    };
    window.requestAnimationFrame(tick);
}

function updateClock() {
    const now = new Date();
    const time = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(now);
    const clock = select("#live-clock");
    const footerTime = select("#footer-time");
    if (clock) {
        clock.textContent = `${time} local`;
    }
    if (footerTime) {
        footerTime.textContent = `Local time ${time}`;
    }
}

function updateSummary(payload) {
    const summary = payload.summary || {};
    const latestYear = payload.latest_year;
    const countryAverage = summary.country_average ?? summary.average;
    animateNumber(select("#hero-average"), countryAverage, (value) => `${value.toFixed(1)}%`);
    animateNumber(select("#hero-reported"), summary.reported);
    animateNumber(select("#hero-extreme"), summary.extreme_pressure);
    animateNumber(select("#stat-reported"), summary.reported);
    animateNumber(select("#stat-high"), summary.high_pressure);
    animateNumber(select("#stat-extreme"), summary.extreme_pressure);
    const yearElement = select("#stat-year");
    const heroYear = select("#hero-year");
    if (yearElement) {
        yearElement.textContent = latestYear || "—";
    }
    if (heroYear) {
        heroYear.textContent = latestYear ? `Latest · ${latestYear}` : "Awaiting latest data";
    }
    const progress = Math.min(100, Math.max(0, Number(countryAverage) || 0));
    const progressElement = select("#hero-progress");
    if (progressElement) {
        progressElement.style.width = `${progress}%`;
    }
    if (payload.generated_at) {
        const generated = new Date(payload.generated_at);
        if (!Number.isNaN(generated.getTime())) {
            setDataStatus(`Map synced · ${generated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
        }
    }
    const sourceUpdated = select("#source-updated");
    if (sourceUpdated) {
        sourceUpdated.textContent = payload.source?.last_updated ? `· updated ${payload.source.last_updated}` : "";
    }
}

async function loadStressData(force = false) {
    const refreshButton = select("#refresh-data");
    if (refreshButton) {
        refreshButton.disabled = true;
    }
    setDataStatus(force ? "Refreshing map data" : "Loading latest observations");
    try {
        const response = await fetch(`/api/water-stress${force ? "?refresh=1" : ""}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.error || "Water-stress data is unavailable");
        }
        state.countries = Array.isArray(payload.countries) ? payload.countries : [];
        state.records = new Map(state.countries.map((country) => [country.iso3, country]));
        updateSummary(payload);
        renderMapLayers();
    } catch (error) {
        setDataStatus("Data service unavailable", "error");
        const message = select("#map-message");
        if (message && !state.geoJson) {
            message.textContent = error.message;
            message.hidden = false;
        }
    } finally {
        if (refreshButton) {
            refreshButton.disabled = false;
        }
    }
}

function featureIso(feature) {
    const properties = feature.properties || {};
    return String(properties["ISO3166-1-Alpha-3"] || properties.iso_a3 || properties.ISO3 || properties.iso3 || "").toUpperCase();
}

function featureName(feature) {
    const properties = feature.properties || {};
    return properties.name || properties.NAME || properties.admin || "Unknown area";
}

function styleForIso(iso) {
    const record = state.records.get(iso);
    const selected = state.selectedIso === iso;
    const filtered = state.filter !== "all" && (!record || record.category !== state.filter);
    const color = record ? CATEGORY_COLORS[record.category] : "#35546a";
    return {
        color: selected ? "#f4fffc" : filtered ? "#38576a" : record ? "#b7f5e7" : "#54758a",
        weight: selected ? 2.4 : 0.65,
        opacity: filtered ? 0.35 : 0.9,
        fillColor: color,
        fillOpacity: selected ? 0.92 : filtered ? 0.18 : record ? 0.76 : 0.34,
    };
}

function tooltipContent(record, name) {
    if (!record) {
        return `<strong>${escapeHtml(name)}</strong><br><span>No latest observation</span>`;
    }
    return `<strong>${escapeHtml(record.name)}</strong><br><span>${formatPercent(record.value)}% · ${escapeHtml(record.label)}</span>`;
}

function refreshLayerStyles() {
    state.countryLayers.forEach((layer, iso) => {
        layer.setStyle(styleForIso(iso));
    });
}

function showInsight(record, name) {
    const empty = select("#insight-empty");
    const detail = select("#insight-detail");
    if (!empty || !detail) {
        return;
    }
    empty.hidden = true;
    detail.hidden = false;
    const nameElement = select("#insight-name");
    const valueElement = select("#insight-value");
    const categoryElement = select("#insight-category");
    const yearElement = select("#insight-year");
    const noteElement = select("#insight-note");
    const meter = select("#insight-meter-fill");
    const status = select("#insight-status");
    if (!record) {
        nameElement.textContent = name;
        valueElement.textContent = "—";
        categoryElement.textContent = "No observation";
        yearElement.textContent = "not reported";
        noteElement.textContent = "The latest public dataset does not include a water-stress observation for this area.";
        meter.style.width = "0%";
        status.style.background = "#54758a";
        return;
    }
    nameElement.textContent = record.name;
    valueElement.textContent = formatPercent(record.value);
    categoryElement.textContent = record.label;
    yearElement.textContent = record.year;
    noteElement.textContent = "Higher values indicate greater pressure on available renewable freshwater resources.";
    meter.style.width = `${Math.min(100, Math.max(0, record.value))}%`;
    status.style.background = CATEGORY_COLORS[record.category];
    status.style.color = CATEGORY_COLORS[record.category];
}

function selectCountry(record, name, layer, iso) {
    state.selectedIso = iso;
    refreshLayerStyles();
    showInsight(record, name);
    if (layer && state.map) {
        const bounds = layer.getBounds();
        if (bounds.isValid()) {
            state.map.flyToBounds(bounds, { maxZoom: 4, duration: 0.7, padding: [35, 35] });
        }
    }
}

function clearSelection() {
    state.selectedIso = null;
    refreshLayerStyles();
    const empty = select("#insight-empty");
    const detail = select("#insight-detail");
    if (empty) {
        empty.hidden = false;
    }
    if (detail) {
        detail.hidden = true;
    }
}

function renderMapLayers() {
    if (!state.map || !state.geoJson) {
        return;
    }
    if (state.layerGroup) {
        state.map.removeLayer(state.layerGroup);
    }
    state.countryLayers = new Map();
    state.layerGroup = L.layerGroup().addTo(state.map);
    state.geoJson.features.forEach((feature, index) => {
        const iso = featureIso(feature);
        const key = iso || `feature-${index}`;
        const record = state.records.get(iso);
        const layer = L.geoJSON(feature, { style: styleForIso(iso) });
        layer.eachLayer((child) => {
            child.bindTooltip(tooltipContent(record, featureName(feature)), { sticky: true, direction: "top" });
            child.on("mouseover", () => child.setStyle({ weight: Math.max(child.options.weight || 0.65, 1.8), fillOpacity: 0.9 }));
            child.on("mouseout", () => child.setStyle(styleForIso(iso)));
            child.on("click", () => selectCountry(record, featureName(feature), child, key));
        });
        state.countryLayers.set(key, layer);
        layer.addTo(state.layerGroup);
    });
}

function setFilter(filter) {
    state.filter = filter;
    selectAll(".filter-button").forEach((button) => {
        button.classList.toggle("active", button.dataset.filter === filter);
    });
    refreshLayerStyles();
}

function findCountry(query) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        return;
    }
    const country = state.countries.find((item) => item.name.toLowerCase().includes(normalized));
    if (!country) {
        return;
    }
    const layer = state.countryLayers.get(country.iso3);
    selectCountry(country, country.name, layer, country.iso3);
}

function initMap() {
    if (!window.L) {
        const loading = select("#map-loading");
        const message = select("#map-message");
        if (loading) {
            loading.hidden = true;
        }
        if (message) {
            message.textContent = "The map library could not be loaded. Check your connection and refresh.";
            message.hidden = false;
        }
        return;
    }
    state.map = L.map("water-map", { zoomControl: false, minZoom: 1.4, maxZoom: 6, worldCopyJump: true, attributionControl: true }).setView([22, 8], 2);
    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    L.tileLayer(MAP_TILE_URL, { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(state.map);
    fetch(MAP_DATA_URL)
        .then((response) => {
            if (!response.ok) {
                throw new Error("Country boundaries could not be loaded");
            }
            return response.json();
        })
        .then((geoJson) => {
            state.geoJson = geoJson;
            const loading = select("#map-loading");
            if (loading) {
                loading.hidden = true;
            }
            renderMapLayers();
        })
        .catch((error) => {
            const loading = select("#map-loading");
            const message = select("#map-message");
            if (loading) {
                loading.hidden = true;
            }
            if (message) {
                message.textContent = error.message;
                message.hidden = false;
            }
        });
}

function clearFormError() {
    const error = select("#form-error");
    if (error) {
        error.hidden = true;
        error.textContent = "";
    }
    selectAll(".field-card.invalid").forEach((field) => field.classList.remove("invalid"));
}

function showFormError(message, fields = {}) {
    const error = select("#form-error");
    if (error) {
        error.textContent = message;
        error.hidden = false;
    }
    Object.entries(fields).forEach(([field]) => {
        const input = select(`#${field === "temperature" ? "temperature" : field}`);
        if (input) {
            input.closest(".field-card").classList.add("invalid");
        }
    });
}

function renderPrediction(payload) {
    const placeholder = select("#result-placeholder");
    const content = select("#result-content");
    if (!placeholder || !content) {
        return;
    }
    placeholder.hidden = true;
    content.hidden = false;
    select("#result-prediction").textContent = payload.prediction || "Unknown";
    select("#result-confidence").textContent = payload.confidence == null ? "Confidence unavailable" : `${payload.confidence}% model confidence`;
    const confidence = Math.min(100, Math.max(0, Number(payload.confidence) || 0));
    select("#confidence-fill").style.width = `${confidence}%`;
    const probabilityList = select("#probability-list");
    const probabilities = Object.entries(payload.probabilities || {}).sort(([, first], [, second]) => second - first);
    probabilityList.innerHTML = probabilities.map(([label, value]) => `<div class="probability-row"><span title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="probability-track"><span style="width: ${Math.min(100, Math.max(0, value))}%"></span></span><span>${formatPercent(value)}%</span></div>`).join("");
    select("#result-disclaimer").textContent = payload.disclaimer || "Illustrative estimate only.";
}

async function submitPrediction(event) {
    event.preventDefault();
    clearFormError();
    const form = event.currentTarget;
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }
    const button = select("#predict-button");
    const originalText = button.innerHTML;
    button.disabled = true;
    button.textContent = "Reading signals…";
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    try {
        const response = await fetch("/api/predict", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) {
            showFormError(data.error || "The scenario could not be evaluated.", data.fields || {});
            return;
        }
        renderPrediction(data);
    } catch {
        showFormError("The prediction service could not be reached.");
    } finally {
        button.disabled = false;
        button.innerHTML = originalText;
    }
}

function setupRevealAnimations() {
    const elements = selectAll(".section-reveal");
    if (!("IntersectionObserver" in window)) {
        elements.forEach((element) => element.classList.add("is-visible"));
        return;
    }
    elements.forEach((element) => element.classList.add("reveal-pending"));
    const observer = new IntersectionObserver((entries, instance) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add("is-visible");
                instance.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12 });
    elements.forEach((element) => observer.observe(element));
}

function bindControls() {
    select("#refresh-data").addEventListener("click", () => loadStressData(true));
    select("#focus-map").addEventListener("click", () => select("#map-section").scrollIntoView({ behavior: "smooth" }));
    select("#clear-selection").addEventListener("click", clearSelection);
    select("#country-search").addEventListener("change", (event) => findCountry(event.target.value));
    select("#country-search").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            findCountry(event.target.value);
        }
    });
    selectAll(".filter-button").forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));
    select("#predictor-form").addEventListener("submit", submitPrediction);
    selectAll(".field-card input").forEach((input) => input.addEventListener("input", () => input.closest(".field-card").classList.remove("invalid")));
}

function init() {
    updateClock();
    window.setInterval(updateClock, 1000);
    bindControls();
    setupRevealAnimations();
    initMap();
    loadStressData();
}

document.addEventListener("DOMContentLoaded", init);
