#!/usr/bin/env python3
"""Regenerates apps/api/src/auth/commonPasswords.ts from a SecLists password list.

    curl -sfLO https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/xato-net-10-million-passwords-100000.txt
    python3 -I scripts/common-passwords.py xato-net-10-million-passwords-100000.txt

Keeps the passwords of 10 or more characters (the minimum), lower-cased, deduplicated, most common first.
"""
import json
import sys

MIN_LENGTH = 10
OUT = 'apps/api/src/auth/commonPasswords.ts'

kept, seen = [], set()
with open(sys.argv[1], encoding='utf-8') as f:
    for line in f:
        p = line.rstrip('\r\n').lower()
        if len(p) >= MIN_LENGTH and p.isprintable() and p not in seen:
            seen.add(p)
            kept.append(p)

body = ',\n'.join('  ' + json.dumps(p) for p in kept)
with open(OUT, 'w') as f:
    f.write(f"""// Generated: every password of 10 or more characters (the minimum) in the
// 100 000 most common passwords of SecLists, lower-cased, in order of how
// common they are. Shorter ones need no list: the minimum already refuses them.
//
// Source: SecLists, Passwords/Common-Credentials/xato-net-10-million-passwords-100000.txt
// https://github.com/danielmiessler/SecLists (MIT License, Copyright (c) 2018 Daniel Miessler)
//
// Regenerate with scripts/common-passwords.py.
// prettier-ignore
export const COMMON_PASSWORDS: readonly string[] = [
{body},
];
""")
print(f'{len(kept)} passwords written to {OUT}')
