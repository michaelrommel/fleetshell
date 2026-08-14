#!/usr/bin/env python3
"""anonymize.py -- reusable anonymization core for the bulk import.

Format-independent building blocks used by load.py once the per-column mapping
is fixed from a sample export:

  * IdMap    - real_key -> new UUID, stable within one run, DISCARDED after.
  * LabelMap - real label -> fake label, stable within one run (same real
               hospital/customer always maps to the same fake), DISCARDED after.
  * fakers   - fully random person names / emails (nothing derived from real).

The maps persist to JSON only so multi-file cross-references resolve during the
run; destroy() removes them, which is what makes the result irreversible.

Requires: Faker  (see requirements.txt)
"""

from __future__ import annotations
import json
import os
import uuid
from faker import Faker

fake = Faker()


class IdMap:
    """Stable real_key -> new UUID for one import run. Discard when done."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._m: dict[str, str] = {}
        if os.path.exists(path):
            with open(path) as f:
                self._m = json.load(f)

    def get(self, real_key: object) -> str:
        k = str(real_key)
        v = self._m.get(k)
        if v is None:
            v = str(uuid.uuid4())
            self._m[k] = v
        return v

    def has(self, real_key: object) -> bool:
        """True if real_key already has a mapping (does NOT create one)."""
        return str(real_key) in self._m

    def save(self) -> None:
        with open(self.path, "w") as f:
            json.dump(self._m, f)

    def destroy(self) -> None:
        self._m = {}
        if os.path.exists(self.path):
            os.remove(self.path)


class LabelMap:
    """Stable real label -> fake label for one run (preserves grouping)."""

    def __init__(self, path: str, generator) -> None:
        self.path = path
        self.gen = generator
        self._m: dict[str, str] = {}
        if os.path.exists(path):
            with open(path) as f:
                self._m = json.load(f)

    def get(self, real: object) -> str:
        k = "" if real is None else str(real)
        v = self._m.get(k)
        if v is None:
            v = self.gen()
            self._m[k] = v
        return v

    def save(self) -> None:
        with open(self.path, "w") as f:
            json.dump(self._m, f)

    def destroy(self) -> None:
        self._m = {}
        if os.path.exists(self.path):
            os.remove(self.path)


# --- random fakers (NOT derived from the real value) ------------------------

def fake_person() -> tuple[str, str]:
    return fake.first_name(), fake.last_name()


def fake_email(seq: int) -> str:
    return f"user{seq}@example.test"


def fake_serial(length: int = 6) -> str:
    return fake.unique.numerify("#" * length)


# Factories for LabelMap generators.
def hospital_generator():
    return lambda: f"{fake.city()} Hospital"


def company_generator():
    return lambda: fake.company()


def site_generator():
    return lambda: f"{fake.city()} Site"
