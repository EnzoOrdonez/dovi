"""Smoke: el app arranca, /health responde, /ingest sin token responde 401."""

from fastapi.testclient import TestClient

from app.main import build_app


def test_health() -> None:
    client = TestClient(build_app())
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_ingest_requires_api_key() -> None:
    client = TestClient(build_app())
    response = client.post("/ingest/cues", json={
        "session_id": "s1",
        "video_id": "v1",
        "platform": "generic",
        "cues": [],
    })
    assert response.status_code == 401


def test_ingest_accepts_with_valid_token() -> None:
    client = TestClient(build_app())
    response = client.post(
        "/ingest/cues",
        headers={"X-DOVI-Token": "test-key"},
        json={
            "session_id": "s1",
            "video_id": "v1",
            "platform": "generic",
            "cues": [],
        },
    )
    assert response.status_code == 200
    assert response.json()["accepted"] == 0
