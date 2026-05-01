"""
FastAPI application — route definitions only.

Business logic lives in auth.py and storage.py.
Wrapped with Mangum to support both ECS/uvicorn and AWS Lambda deployments.
"""

from fastapi import Depends, FastAPI, File, UploadFile
from mangum import Mangum

from auth import require_authenticated_user
from storage import delete_file, list_files, upload_file

app = FastAPI(title="stratocore")


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
    content = await file.read()
    upload_file(username, file.filename or "unnamed", content)
    return {"filename": file.filename or "unnamed"}


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
    delete_file(username, filename)


# Mangum wraps the ASGI app for AWS Lambda — unused when running under uvicorn.
handler = Mangum(app)
