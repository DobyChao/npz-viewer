from __future__ import annotations


class AppError(Exception):
    """Domain error carrying the machine-readable code the API contract promises."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        hint: str | None = None,
        status: int = 400,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.status = status

    def to_detail(self) -> dict[str, str | None]:
        return {"code": self.code, "message": self.message, "hint": self.hint}


class PathOutsideRoot(AppError):
    def __init__(self, path: str) -> None:
        super().__init__(
            "PATH_OUTSIDE_ROOT",
            f"路径不在任何已配置的 root 之下: {path}",
            hint="在顶栏的「管理 root」中添加包含该路径的 root。",
            status=403,
        )


class FileNotFound(AppError):
    def __init__(self, path: str) -> None:
        super().__init__("FILE_NOT_FOUND", f"文件或目录不存在: {path}", status=404)


class KeyNotFound(AppError):
    def __init__(self, key: str, path: str) -> None:
        super().__init__("KEY_NOT_FOUND", f"npz 中不存在 key「{key}」: {path}", status=404)


class UnsupportedKind(AppError):
    def __init__(self, message: str) -> None:
        super().__init__("UNSUPPORTED_KIND", message, status=415)


class NeedsPickle(AppError):
    def __init__(self, path: str) -> None:
        super().__init__(
            "NEEDS_PICKLE",
            f"该 npz 含有 object 数组，需要 pickle 才能读取: {path}",
            hint="确认文件来源可信后，用 --allow-pickle 重启后端。",
            status=415,
        )


class BadParam(AppError):
    def __init__(self, message: str) -> None:
        super().__init__("BAD_PARAM", message, status=400)
