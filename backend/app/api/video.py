from __future__ import annotations

import asyncio

from fastapi import APIRouter
from fastapi.responses import FileResponse

from ..errors import FileNotFound
from ..models import VideoExportRequest, VideoJobInfo
from ..services import video_export
from .deps import resolve_file

router = APIRouter(prefix="/api/video", tags=["video"])


def _job_or_404(job_id: str) -> video_export.VideoJob:
    job = video_export.jobs.get(job_id)
    if job is None:
        raise FileNotFound(f"导出任务不存在: {job_id}")
    return job


@router.post("/export", response_model=VideoJobInfo)
async def export_video(body: VideoExportRequest) -> VideoJobInfo:
    target = resolve_file(body.path)
    job = await asyncio.to_thread(video_export.start_export, target, body)
    return job.info()


@router.get("/jobs/{job_id}", response_model=VideoJobInfo)
async def job_status(job_id: str) -> VideoJobInfo:
    return _job_or_404(job_id).info()


@router.post("/jobs/{job_id}/cancel", response_model=VideoJobInfo)
async def cancel_job(job_id: str) -> VideoJobInfo:
    job = _job_or_404(job_id)
    if job.status in ("queued", "running"):
        job.cancel.set()
    return job.info()


@router.get("/jobs/{job_id}/file")
async def job_file(job_id: str) -> FileResponse:
    job = _job_or_404(job_id)
    if job.status != "done" or job.output_path is None or not job.output_path.is_file():
        raise FileNotFound(f"导出文件尚未就绪: {job_id}")
    return FileResponse(
        job.output_path,
        media_type="video/mp4",
        filename=job.filename or f"{job.id}.mp4",
        content_disposition_type="inline",
    )
