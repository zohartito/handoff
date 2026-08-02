# Attempts

<!-- Appended by `handoff attempt`. Newest last. -->

## 2026-07-01T09:00:00Z

**tried:** added a fixed 2-second sleep before the upload assertion

**error:**

```
test_upload still fails intermittently under CI load
```

**fix:** none — sleeping just moved the flake around

---

## 2026-07-03T09:00:00Z

**tried:** raised the pytest-timeout for test_upload to 30 seconds

**error:**

```
test now hangs to the timeout instead of failing fast
```

**fix:** none — the timeout hid the race, did not fix it

---

## 2026-07-05T09:00:00Z

**tried:** mocked the S3 client entirely so the upload never touches the network

**error:**

```
test passes but no longer exercises the real upload path
```

**fix:** reverted — the mock defeats the point of the integration test

---
