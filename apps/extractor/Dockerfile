# The extractor: Docling behind POST /extract. Build from the repository root:
#   docker build -f apps/extractor/Dockerfile -t living-wiki-extractor .
# Models are downloaded at build time and the service runs offline (HF_HUB_OFFLINE), as
# a user without privileges. It has no storage access: the worker sends bytes and gets JSON.
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app
WORKDIR /repo/apps/extractor
COPY apps/extractor/requirements.txt ./
# CPU builds of torch keep the image far smaller than the default CUDA wheels.
RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r requirements.txt
USER app
ENV HOME=/home/app
RUN docling-tools models download
# Docling reads its models from here and never looks anything up online.
ENV DOCLING_ARTIFACTS_PATH=/home/app/.cache/docling/models HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
COPY --chown=app apps/extractor/app ./app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["uvicorn", "app.main:build", "--factory", "--host", "0.0.0.0", "--port", "8000"]

# docker build --target test ...: the unit tests plus, with EXTRACTOR_DOCLING_TESTS=1, the real pipeline.
FROM runtime AS test
RUN pip install pytest==9.1.1 httpx==0.28.1
COPY --chown=app apps/extractor/pytest.ini ./
COPY --chown=app apps/extractor/tests ./tests
COPY --chown=app packages/contracts/fixtures /repo/packages/contracts/fixtures
CMD ["python", "-m", "pytest", "-q"]
