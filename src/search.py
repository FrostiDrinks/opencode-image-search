# /// script
# dependencies = [
#   "PicImageSearch",
#   "typing_extensions",
# ]
# ///

import json
import os
import sys
from http.cookies import SimpleCookie

from PicImageSearch.model.base import BaseSearchItem

ENGINE_MAP: dict[str, type] = {}


def _register(cls: type) -> type:
    ENGINE_MAP[cls.__name__] = cls
    return cls


@_register
class SyncYandex:
    def __init__(self) -> None:
        from PicImageSearch.sync import Yandex

        self._engine = Yandex(**proxy_kwargs(), **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        return _items(result.raw, limit, ("title", "url", "thumbnail", "source", "content", "size"))


@_register
class SyncSauceNAO:
    def __init__(self) -> None:
        from PicImageSearch.sync import SauceNAO

        kwargs = proxy_kwargs()
        api_key = os.environ.get("IMAGE_SEARCH_API_KEY")
        if api_key:
            kwargs["api_key"] = api_key
        self._engine = SauceNAO(**kwargs, **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        return _items(result.raw, limit, ("title", "url", "thumbnail", "similarity", "source", "author"))


@_register
class SyncAscii2D:
    def __init__(self) -> None:
        from PicImageSearch.sync import Ascii2D

        self._engine = Ascii2D(**proxy_kwargs(), **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        items = []
        for i, item in enumerate(result.raw[:limit]):
            entry = {
                "index": i + 1,
                "title": getattr(item, "detail", ""),
                "thumbnail": item.thumbnail,
                "source": getattr(item, "author", ""),
            }
            url_list = getattr(item, "url_list", [])
            if url_list:
                entry["url"] = str(url_list[0])
            else:
                entry["url"] = ""
            items.append(entry)
        return items


@_register
class SyncBing:
    def __init__(self) -> None:
        from PicImageSearch.sync import Bing

        self._engine = Bing(**proxy_kwargs(), **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        return _items(result.raw, limit, ("title", "url", "thumbnail", "image_url"))


@_register
class SyncIqdb:
    def __init__(self) -> None:
        from PicImageSearch.sync import Iqdb

        self._engine = Iqdb(**proxy_kwargs(), **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        return _items(result.raw, limit, ("content", "source", "other_source", "size", "url", "thumbnail"))


@_register
class SyncTraceMoe:
    def __init__(self) -> None:
        from PicImageSearch.sync import TraceMoe

        self._engine = TraceMoe(**proxy_kwargs(), **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        items = []
        for i, item in enumerate(result.raw[:limit]):
            entry = {
                "index": i + 1,
                "title": getattr(item, "title_romaji", "") or getattr(item, "title_english", "") or getattr(item, "title_native", ""),
                "url": getattr(item, "video", "") or getattr(item, "image", ""),
                "thumbnail": getattr(item, "image", "") or getattr(item, "video", ""),
                "similarity": getattr(item, "similarity", None),
                "source": getattr(item, "filename", ""),
                "episode": getattr(item, "episode", None),
                "anilist_id": getattr(item, "anilist", None) or getattr(item, "idMal", None),
            }
            items.append(entry)
        return items


@_register
class SyncTineye:
    def __init__(self) -> None:
        from PicImageSearch.sync import Tineye

        self._engine = Tineye(**proxy_kwargs(), **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        return _items(result.raw, limit, ("title", "url", "thumbnail", "domain", "size", "crawl_date"))


@_register
class SyncGoogleLens:
    def __init__(self) -> None:
        from PicImageSearch.sync import GoogleLens

        self._engine = GoogleLens(**proxy_kwargs(), **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        return _items(result.raw, limit, ("title", "url", "thumbnail", "site_name"))


@_register
class SyncEHentai:
    def __init__(self) -> None:
        from PicImageSearch.sync import EHentai

        self._engine = EHentai(**proxy_kwargs(), **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        return _items(result.raw, limit, ("title", "url", "thumbnail", "type", "date", "tags"))


@_register
class SyncBaiDu:
    def __init__(self) -> None:
        from PicImageSearch.sync import BaiDu

        self._engine = BaiDu(**proxy_kwargs(), **cookies_kwargs())

    def search(self, url: str, limit: int) -> list[dict]:
        result = self._engine.search(url=url)
        return _items(result.raw, limit, ("title", "url", "thumbnail", "similarity"))


def proxy_kwargs() -> dict:
    proxy = (
        os.environ.get("IMAGE_SEARCH_PROXY")
        or os.environ.get("HTTPS_PROXY")
        or os.environ.get("HTTP_PROXY")
    )
    if not proxy:
        return {}
    return {"proxies": {"all://": proxy}}


def cookies_kwargs() -> dict:
    raw = os.environ.get("IMAGE_SEARCH_COOKIES")
    if not raw:
        return {}
    try:
        c = SimpleCookie(raw)
        cookies = {k: v.value for k, v in c.items()}
        return {"cookies": cookies} if cookies else {}
    except Exception:
        return {}


def _items(raw: list[BaseSearchItem], limit: int, fields: tuple[str, ...]) -> list[dict]:
    items: list[dict] = []
    for i, item in enumerate(raw[:limit]):
        entry: dict = {"index": i + 1}
        for f in fields:
            val = getattr(item, f, None)
            if val is not None:
                entry[f] = _serialize(val)
        if "thumbnail" not in entry:
            entry["thumbnail"] = ""
        if "title" not in entry:
            entry["title"] = ""
        if "url" not in entry:
            entry["url"] = ""
        _parse_size(entry)
        items.append(entry)
    return items


def _parse_size(entry: dict) -> None:
    raw = entry.get("size")
    if isinstance(raw, str) and "x" in raw:
        parts = raw.split("x")
        if len(parts) == 2:
            try:
                entry["width"] = int(parts[0])
                entry["height"] = int(parts[1])
            except ValueError:
                pass


def _serialize(val):
    if isinstance(val, (list, tuple)):
        return [_serialize(v) for v in val]
    if isinstance(val, dict):
        return {k: _serialize(v) for k, v in val.items()}
    if not isinstance(val, (str, int, float, bool, type(None))):
        return str(val)
    return val


ENGINE_ALIASES: dict[str, str] = {
    "Google": "GoogleLens",
}

ENGINE_NAMES: set[str] = set(ENGINE_MAP.keys())


def main() -> None:
    try:
        args = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        _error(f"Invalid JSON input: {e}")
        return

    source = args.get("source", "")
    if not source:
        _error("Missing 'source'")
        return

    engine_name = args.get("engine", "Yandex")
    engine_name = ENGINE_ALIASES.get(engine_name, engine_name)
    limit = max(1, min(100, args.get("limit", 10)))

    engine_cls_name = f"Sync{engine_name}"
    engine_cls = ENGINE_MAP.get(engine_cls_name)
    if not engine_cls:
        _error(f"Unknown engine: {engine_name}. Supported: {sorted(n.removeprefix('Sync') for n in ENGINE_NAMES)}")
        return

    try:
        engine = engine_cls()
        items = engine.search(url=source, limit=limit)
        print(json.dumps({"engine": engine_name, "count": len(items), "results": items}, default=str))
    except Exception as e:
        _error(str(e))


def _error(msg: str) -> None:
    print(json.dumps({"error": msg}))


if __name__ == "__main__":
    main()
