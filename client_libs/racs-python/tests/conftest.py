import os

import pytest

from racs_python import RacsClient

# The fake server starts every camera at this size (`examples/fake_server.rs`).
WIDTH = 64
HEIGHT = 32


@pytest.fixture(scope="session")
def server_url() -> str:
    url = os.environ.get("RACS_TEST_URL")
    if not url:
        pytest.skip("RACS_TEST_URL is not set; run client_libs/run-tests.sh")
    return url


@pytest.fixture
def client(server_url):
    with RacsClient(server_url) as client:
        yield client


@pytest.fixture
def make_client(server_url):
    """Makes more clients (``RacsClient`` arguments), closed after the test, so their sessions end and their leases go."""
    made = []

    def make(**kwargs) -> RacsClient:
        made.append(RacsClient(server_url, **kwargs))
        return made[-1]

    yield make
    for client in made:
        client.close()


@pytest.fixture
def cam(client):
    """Device 0, put back to its starting state after the test."""
    cam = client.camera(0)
    yield cam
    cam.set("Width", WIDTH)
    cam.set("Height", HEIGHT)
    cam.set("ReverseX", False)
    cam.set("GevSCPSPacketSize", 1500)
