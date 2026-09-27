"""Runs twitter-cli with its ClientTransaction initialised from x.com/home + the session cookie.

Workaround for https://github.com/public-clis/twitter-cli/issues/88: x.com's new homepage no
longer links the ondemand.s bundle, so twitter-cli cannot build the x-client-transaction-id header
and SearchTimeline returns HTTP 404. The logged-in x.com/home page still links it.

signal-radar runs this with twitter-cli's own Python (read from the `twitter` launcher's shebang)
for `search` only. It patches the method in memory; nothing on disk is modified. Arguments are
passed straight to twitter-cli, e.g.: python twitter_x_home.py search "AI agents" -n 20 --json
"""
import sys

try:
    import bs4
    from twitter_cli import client as C
    from x_client_transaction import ClientTransaction
    from x_client_transaction.utils import generate_headers, get_ondemand_file_url
except ImportError as exc:  # twitter-cli changed its internals: run it unpatched
    C = None
    _IMPORT_ERROR = exc

# Private names the patch relies on. If an upgrade renames any of them, run twitter-cli unpatched
# (plain search then 404s as before, or works if upstream fixed #88) instead of crashing.
_NEEDED = (
    "_ct_init_attempted", "_load_ct_cache", "_cookie_string", "_save_ct_cache",
)
_NEEDED_MODULE = ("_get_cffi_session", "_update_features_from_html", "logger")


def _ensure_client_transaction(self):
    if self._ct_init_attempted:
        return
    self._ct_init_attempted = True
    if self._load_ct_cache():
        return
    try:
        session = C._get_cffi_session()
        headers = generate_headers()
        headers["Cookie"] = self._cookie_string or "auth_token=%s; ct0=%s" % (self._auth_token, self._ct0)
        home = session.get("https://x.com/home", headers=headers, timeout=10)
        soup = bs4.BeautifulSoup(home.content, "html.parser")
        ondemand = session.get(get_ondemand_file_url(response=soup), headers=headers, timeout=10)
        self._client_transaction = ClientTransaction(
            home_page_response=soup, ondemand_file_response=ondemand.text
        )
        C._update_features_from_html(home.text)
        self._save_ct_cache(home.text, ondemand.text)
    except Exception as exc:  # same as upstream: warn and continue without the header
        C.logger.warning("Failed to init ClientTransaction (x.com/home): %s", exc)


def _compatible():
    if C is None:
        return "import failed: %s" % _IMPORT_ERROR
    missing = [n for n in _NEEDED_MODULE if not hasattr(C, n)]
    cls = getattr(C, "TwitterClient", None)
    if cls is None or not hasattr(cls, "_ensure_client_transaction"):
        missing.append("TwitterClient._ensure_client_transaction")
    else:
        src = getattr(cls, "__init__", None)
        names = getattr(getattr(src, "__code__", None), "co_names", ()) + tuple(dir(cls))
        missing += [n for n in _NEEDED if n not in names]
    return "missing " + ", ".join(missing) if missing else None


_problem = _compatible()
if _problem:
    print("signal-radar shim: twitter-cli internals changed (%s); running it unpatched" % _problem,
          file=sys.stderr)
else:
    C.TwitterClient._ensure_client_transaction = _ensure_client_transaction

from twitter_cli.cli import cli  # noqa: E402

sys.exit(cli())
