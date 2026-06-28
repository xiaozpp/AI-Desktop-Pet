def initial_care_delay(last_seen: int | float | None, now: int | float) -> int:
    if last_seen is not None and now - last_seen >= 24 * 60 * 60:
        return 5 * 60
    return 45 * 60
