# Build stage — install dependencies into an isolated layer.
FROM python:3.12-slim AS builder

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# Runtime stage — minimal image, no build tools.
FROM python:3.12-slim

# Run as a non-root user.
RUN useradd --no-create-home --shell /bin/false appuser

WORKDIR /app

# Copy installed packages from the build stage.
COPY --from=builder /install /usr/local

COPY . .

RUN chown -R appuser:appuser /app
USER appuser

# S3_BUCKET_NAME, DYNAMO_TABLE_NAME and AWS_REGION are injected
# by the ECS task definition at runtime — not set here.
EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
