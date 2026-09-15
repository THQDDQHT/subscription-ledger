#!/usr/bin/env python3
"""Authenticated ledger client; credentials stay in environment, writes use explicit retry keys."""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('method', choices=['GET', 'POST', 'PUT', 'DELETE'])
    parser.add_argument('path', help='Relative API path, e.g. /items or /reminders')
    parser.add_argument('--body', help='UTF-8 JSON file for a write operation')
    parser.add_argument('--key', help='Stable UUID per write intent; reuse only for identical retries')
    args = parser.parse_args()
    base = os.environ.get('LEDGER_BASE_URL', '').rstrip('/')
    token = os.environ.get('LEDGER_API_TOKEN', '')
    url = urllib.parse.urlsplit(base)
    if not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        parser.error('LEDGER_BASE_URL must be the ledger root URL without credentials or parameters')
    if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')):
        parser.error('Use HTTPS, or loopback HTTP on the ledger host')
    if not re.fullmatch(r'ledger_[A-Za-z0-9_-]{43}', token):
        parser.error('Set a valid LEDGER_API_TOKEN in the agent environment')
    if not re.fullmatch(r'/(?:items(?:/[a-f0-9]{32}(?:/(?:topup|reconcile|bill|renew|balance-entries|renewals)(?:/[a-f0-9]{32}/undo)?)?)?|summary|reminders|openapi\.json)', args.path):
        parser.error('Unsupported API path')
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    data = None
    if args.method != 'GET':
        if not args.body or not args.key or not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', args.key):
            parser.error('Writes require --body and a stable --key (8-128 characters)')
        with open(args.body, encoding='utf-8') as f:
            body = json.load(f)
        if not isinstance(body, dict):
            parser.error('Body must be a JSON object')
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers['Idempotency-Key'] = args.key
    request = urllib.request.Request(base + '/api/v1' + args.path, data=data, headers=headers, method=args.method)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            result = json.load(response)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as e:
        try:
            error = json.load(e).get('error', 'Request rejected')
        except (ValueError, AttributeError):
            error = 'Request rejected'
        print(json.dumps({'status': e.code, 'error': error}, ensure_ascii=False), file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError, OSError):
        print('Network request failed. For writes, verify state or retry with the SAME body and key.', file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError):
        print('Cannot read request JSON or parse response.', file=sys.stderr)
        sys.exit(1)
