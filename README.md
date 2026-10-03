# ⚠️ This repository has moved

> [!CAUTION]
> **`@iremlopsum/apify` is no longer maintained under this name.**
> It continues as **[liaise](https://github.com/iremlopsum/liaise)** — same author, same code,
> same API, full history.

## Switch in two steps

```bash
npm uninstall @iremlopsum/apify
npm install liaise
```

Then replace the import path:

| Before | After |
|---|---|
| `@iremlopsum/apify` | `liaise` |
| `@iremlopsum/apify/middleware` | `liaise/middleware` |
| `@iremlopsum/apify/testing` | `liaise/testing` |

The only behaviour change: `logMiddleware` and `cacheMiddleware` now log with the `[liaise]`
prefix instead of `[apify]`. Full guide:
[MIGRATION.md](https://github.com/iremlopsum/liaise/blob/main/MIGRATION.md#upgrading-to-500).

## Why the new name?

"apify" is also the name of an unrelated, well-known company, which made this library hard to
find and easy to confuse. *Liaise* (lee-AYZ) means "to act as the link between two parties" —
which is what an API client does.

---

New issues, questions and releases: **[github.com/iremlopsum/liaise](https://github.com/iremlopsum/liaise)**.
This repository is archived and read-only.
