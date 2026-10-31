"""Local, single-operation boundary. Never pass a URL or cloud/LLM client to MarkItDown."""
import json
import os
import pathlib
import sys
import zipfile
from importlib.metadata import version
from email.message import Message


def run(operation, source, output, info, member=None):
    if operation == "zip-list":
        with zipfile.ZipFile(source) as archive:
            entries = [{"index": i, "name": item.filename,
                        "declaredSize": str(item.file_size), "directory": item.is_dir()}
                       for i, item in enumerate(archive.infolist())]
        pathlib.Path(output).write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"operation": operation, "memberCount": len(entries), "engine": "python.zipfile", "engineVersion": sys.version.split()[0]}
    if operation == "zip-member":
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if not isinstance(member, int) or member < 0 or member >= len(entries):
                raise ValueError("member index does not identify an archive entry")
            selected = entries[member]
            if selected.is_dir():
                raise ValueError("selected member is a directory")
            # Explicit selection only; names never become filesystem destinations.
            data = archive.read(selected)
        pathlib.Path(output).write_bytes(data)
        return {"operation": operation, "engine": "python.zipfile", "engineVersion": sys.version.split()[0], "member": {
            "index": member, "name": selected.filename, "declaredSize": str(selected.file_size)}}
    if operation != "convert":
        raise ValueError("unknown local conversion operation")
    from markitdown import MarkItDown, StreamInfo
    from markitdown.converters import HtmlConverter, PdfConverter, DocxConverter, PlainTextConverter
    filename = info.get("filename") or "source"
    extension = pathlib.PurePosixPath(filename).suffix.lower()
    media = Message()
    if info.get("mimetype"):
        media["content-type"] = info["mimetype"]
    mimetype = media.get_content_type() if info.get("mimetype") else None
    if extension == ".zip" or info.get("mimetype", "").split(";")[0] == "application/zip" or (zipfile.is_zipfile(source) and extension not in {".docx", ".pptx", ".xlsx"} and "officedocument" not in info.get("mimetype", "")):
        raise ValueError("list the ZIP and explicitly select a member before conversion")
    # Public registration API: only local document converters, never ZipConverter
    # or network/cloud/model converters, including format-guess fallback paths.
    engine = MarkItDown(enable_builtins=False, enable_plugins=False)
    for converter in (PlainTextConverter(), HtmlConverter(), PdfConverter(), DocxConverter()):
        engine.register_converter(converter)
    with open(source, "rb") as stream:
        result = engine.convert_stream(
            stream, stream_info=StreamInfo(filename=filename, extension=extension or None,
                                          mimetype=mimetype, charset=media.get_content_charset()))
    pathlib.Path(output).write_text(result.text_content, encoding="utf-8")
    return {"operation": operation, "engine": "Microsoft MarkItDown", "engineVersion": version("markitdown"),
            "title": result.title}


if __name__ == "__main__":
    os.umask(0o077)
    try:
        operation, source, output, raw_info = sys.argv[1:5]
        info = json.loads(raw_info)
        print(json.dumps(run(operation, source, output, info, info.get("member")), ensure_ascii=False))
    except Exception as error:
        # Do not turn an engine traceback/document excerpt into a source preview.
        message = "Local conversion could not complete; check the source format and pinned Python installation."
        if isinstance(error, ModuleNotFoundError):
            message = "Install python/requirements.lock with the selected interpreter."
        elif sys.argv[1:2] and sys.argv[1] in {"zip-list", "zip-member"}:
            message = str(error)
        print(json.dumps({"error": type(error).__name__, "message": message}))
        sys.exit(1)
