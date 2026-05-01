"""
FastAPI application — route definitions only.

Business logic lives in auth.py and storage.py.
Wrapped with Mangum to support both ECS/uvicorn and AWS Lambda deployments.
"""

import re

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status
from mangum import Mangum

from auth import require_authenticated_user
from storage import delete_file, list_files, upload_file

app = FastAPI(title="stratocore")

# Maximum upload size — prevents abuse and stays within Lambda's 6 MB payload limit.
_MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

# Allowed filename characters — ASCII only to prevent path traversal and S3 key issues.
# \w would match Unicode letters, which is unpredictable in S3 key handling.
_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe. No authentication required."""
    return {"status": "healthy"}


@app.post("/upload", status_code=201)
async def upload(
    file: UploadFile = File(...),
    username: str = Depends(require_authenticated_user),
) -> dict[str, str]:
    """Upload a file to S3 under the authenticated user's prefix."""
    filename = file.filename or "unnamed"
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid filename.")
    content = await file.read()
    if len(content) > _MAX_FILE_SIZE:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File too large. Maximum size is 10 MB.")
    upload_file(username, filename, content)
    return {"filename": filename}


@app.get("/files")
def list_user_files(
    username: str = Depends(require_authenticated_user),
) -> dict[str, list[str]]:
    """List all files belonging to the authenticated user."""
    return {"files": list_files(username)}


@app.delete("/files/{filename}", status_code=204)
def delete_user_file(
    filename: str,
    username: str = Depends(require_authenticated_user),
) -> None:
    """Delete a file belonging to the authenticated user."""
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid filename.")
    delete_file(username, filename)


# Lambda entry point — Mangum translates between the Lambda event format and ASGI.
# ECS ignores this and uses uvicorn directly (CMD override in the task definition).
handler = Mangum(app)
