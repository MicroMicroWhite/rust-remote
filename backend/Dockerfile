ARG UV_IMAGE=astral/uv:python3.11-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:28-cli
FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${UV_IMAGE}
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 DATA_DIR=/data \
    DOCKER_CONFIG=/data/docker CLIENT_SOURCE_DIR=/build-source/client
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend/lib ./lib
COPY client /build-source/client
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN useradd --system --uid 10001 app && mkdir /data && chown app:app /data
USER app
EXPOSE 8000
CMD ["/app/.venv/bin/uvicorn", "lib.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--ws-max-size", "12582912", "--no-access-log"]
