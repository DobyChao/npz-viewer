from __future__ import annotations

import argparse
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import orjson
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import fs, nav, npz, roots, video
from .config import Settings, get_settings, set_settings
from .errors import AppError
from .models import Health

logger = logging.getLogger("npz_view")


def _bootstrap_roots_file(path: Path) -> None:
    if path.exists():
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(orjson.dumps({"roots": []}, option=orjson.OPT_INDENT_2))
        logger.info("created empty roots file at %s", path)
    except OSError as exc:
        logger.warning("could not create %s: %s", path, exc)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    settings.ensure_dirs()
    _bootstrap_roots_file(settings.roots_file)
    logger.info("npz_view %s ready; cache at %s", __version__, settings.cache_dir)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="npz_view", version=__version__, lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started) * 1000
        if request.url.path.startswith("/api"):
            logger.info(
                "%s %s -> %s (%.0fms)",
                request.method,
                request.url.path,
                response.status_code,
                elapsed_ms,
            )
        response.headers["X-Elapsed-Ms"] = f"{elapsed_ms:.1f}"
        return response

    @app.exception_handler(AppError)
    async def handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content={"detail": exc.to_detail()})

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        location = ".".join(str(part) for part in first.get("loc", ())[1:])
        return JSONResponse(
            status_code=400,
            content={
                "detail": {
                    "code": "BAD_PARAM",
                    "message": f"参数 {location or '?'} 无效: {first.get('msg', '')}",
                    "hint": None,
                }
            },
        )

    @app.exception_handler(OSError)
    async def handle_os_error(_request: Request, exc: OSError) -> JSONResponse:
        logger.exception("filesystem error")
        return JSONResponse(
            status_code=500,
            content={
                "detail": {
                    "code": "IO_ERROR",
                    "message": f"文件系统错误: {exc}",
                    "hint": "确认路径可访问且未被占用。",
                }
            },
        )

    @app.get("/api/health", response_model=Health, tags=["meta"])
    async def health() -> Health:
        return Health(ok=True, version=__version__)

    @app.get("/api/settings", tags=["meta"])
    async def server_settings() -> dict[str, object]:
        current = get_settings()
        return {
            "version": __version__,
            "small_matrix_max": current.small_matrix_max,
            "allow_pickle": current.allow_pickle,
            "embed_icc": current.embed_icc,
            "cache_dir": current.cache_dir.as_posix(),
            "roots_file": current.roots_file.as_posix(),
        }

    app.include_router(roots.router)
    app.include_router(fs.router)
    app.include_router(npz.router)
    app.include_router(nav.router)
    app.include_router(video.router)

    if settings.static_dir and settings.static_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="static")
        logger.info("serving frontend from %s", settings.static_dir)

    return app


app = create_app()


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="npz_view", description="npz 浏览器后端")
    defaults = Settings()
    parser.add_argument("--host", default=defaults.host)
    parser.add_argument("--port", type=int, default=defaults.port)
    parser.add_argument("--roots-file", type=Path, default=defaults.roots_file)
    parser.add_argument("--cache-dir", type=Path, default=defaults.cache_dir)
    parser.add_argument("--max-cache-gb", type=float, default=defaults.max_cache_gb)
    parser.add_argument("--array-cache-mb", type=int, default=defaults.array_cache_mb)
    parser.add_argument("--small-matrix-max", type=int, default=defaults.small_matrix_max)
    parser.add_argument(
        "--allow-pickle",
        action="store_true",
        help="允许读取含 object 数组的 npz（会执行文件里的 pickle，仅用于可信数据）",
    )
    parser.add_argument(
        "--static-dir",
        type=Path,
        default=None,
        help="生产模式下 frontend/dist 的路径，设置后由后端直接托管前端",
    )
    parser.add_argument("--log-level", default="info")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    args = _parse_args(argv)
    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    set_settings(
        Settings(
            host=args.host,
            port=args.port,
            roots_file=args.roots_file,
            cache_dir=args.cache_dir,
            max_cache_gb=args.max_cache_gb,
            array_cache_mb=args.array_cache_mb,
            small_matrix_max=args.small_matrix_max,
            allow_pickle=args.allow_pickle,
            static_dir=args.static_dir,
        )
    )
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level=args.log_level)


if __name__ == "__main__":
    main()
