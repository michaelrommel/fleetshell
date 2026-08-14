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
import random
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


# --- device-identity generators (format-preserving, stable via LabelMap) -----
# These fake the VALUE while keeping the general SHAPE, so the anonymized dump
# stays realistic and searchable without being identifying.

def functional_location_generator():
    # IDENTIFIER3 shape: NNN-NNNNNN (a 3-digit prefix + a numeric tail).
    return lambda: f"{random.randint(0, 999):03d}-{random.randint(0, 999999):06d}"


def ip_generator():
    # A plausible private-range IPv4 (10/172.16-31/192.168), like the source.
    def gen():
        block = random.choice(("10", "172", "192"))
        if block == "10":
            return f"10.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}"
        if block == "172":
            return f"172.{random.randint(16,31)}.{random.randint(0,255)}.{random.randint(1,254)}"
        return f"192.168.{random.randint(0,255)}.{random.randint(1,254)}"
    return gen


def technical_ident_generator():
    # SYSTEMID2 shape: a free-form asset tag (letters + digits, sometimes dashed).
    return lambda: fake.bothify("??####-##").upper()


def hostid_generator():
    # HOSTID shape: a hex host/hardware id, e.g. '9-0f28c0e2'.
    return lambda: f"{random.randint(8,9)}-{fake.hexify('^^^^^^^^')}"


def orderno_generator():
    # ORDERNO shape: a numeric order/PO number.
    return lambda: fake.numerify("########")


def contact_generator():
    # CONTACT is PII (name + phone). Replace wholesale with a fake person + phone.
    return lambda: f"{fake.first_name()} {fake.last_name()} {fake.phone_number()}"
