#!/usr/bin/env python3
import os
import json
import sys
from pathlib import Path

def authenticate():
    username = os.environ.get('EVS_USERNAME')
    password = os.environ.get('EVS_PASSWORD')
    
    if not username or not password:
        print("Error: EVS_USERNAME and EVS_PASSWORD environment variables must be set")
        sys.exit(1)
    config_dir = Path.home() / '.config' / 'evs'
    config_file = config_dir / 'config.json'
    config_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Authenticating EVS account: {username}")
    
    try:
        from castlabs_evs.auth import Auth
        auth = Auth(no_ask=True)
        auth._refresh_auth(username, password)
        
        print("EVS authentication successful!")
        return True
        
    except Exception as e:
        print(f"EVS authentication failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    authenticate()
