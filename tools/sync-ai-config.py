#!/usr/bin/env python3
"""Generate PUBLIC Firebase AI Logic config from GitHub Repository Variables."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
ALLOWED={"gemini-3.5-flash-lite","gemini-3.1-flash-lite"}
def sync(root, env):
    raw=env.get("MINKOME_AI_FIREBASE_CONFIG","").strip()
    site_key=env.get("MINKOME_AI_APP_CHECK_SITE_KEY","").strip()
    spark=env.get("MINKOME_AI_SPARK_VERIFIED","").strip().lower()=="true"
    model=env.get("MINKOME_AI_MODEL","").strip() or "gemini-3.5-flash-lite"
    if model not in ALLOWED:
        raise ValueError("MINKOME_AI_MODEL must be a supported free-tier model.")
    if raw or site_key or spark:
        if not (raw and site_key and spark):
            raise ValueError("Set MINKOME_AI_FIREBASE_CONFIG, MINKOME_AI_APP_CHECK_SITE_KEY and MINKOME_AI_SPARK_VERIFIED=true together.")
        firebase=json.loads(raw)
        if not isinstance(firebase,dict) or any(not isinstance(firebase.get(k),str) or not firebase[k].strip() for k in ("apiKey","appId","projectId")):
            raise ValueError("Firebase Web config needs apiKey, appId and projectId.")
        if any(any(word in k.lower() for word in ("secret","password","private")) for k in firebase):
            raise ValueError("Do not embed secrets in public Firebase config.")
        config={"mode":"shared-firebase","firebase":firebase,"appCheckSiteKey":site_key,"model":model}
    else:
        config={"mode":"disabled","firebase":None,"appCheckSiteKey":"","model":model}
    output=("/* Generated PUBLIC Firebase configuration. Never place secrets here. */\n"
      +"globalThis.MINKOME_AI_CONFIG=Object.freeze("
      +json.dumps(config,ensure_ascii=False,separators=(",",":"))+");\n")
    (root/"ai-config.js").write_text(output,encoding="utf-8")
    fingerprint=hashlib.sha256(output.encode("utf-8")).hexdigest()[:12]
    index_path=root/"index.html"
    index=index_path.read_text(encoding="utf-8")
    pattern=r'(<script src="ai-config\.js\?v=[^"&]+)(?:&(?:amp;)?id=[0-9a-f]{12})?(" defer></script>)'
    changed,count=re.subn(pattern,lambda m:m.group(1)+"&amp;id="+fingerprint+m.group(2),index)
    if count!=1:raise ValueError("Expected one versioned ai-config.js script.")
    if changed!=index:index_path.write_text(changed,encoding="utf-8")
    return fingerprint
if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--root",type=Path,default=Path(__file__).resolve().parent.parent)
    args=parser.parse_args()
    try:print("Firebase public AI config fingerprint: "+sync(args.root,os.environ))
    except (ValueError,OSError,json.JSONDecodeError) as error:
        parser.exit(1,"Firebase AI config sync failed: "+str(error)+"\n")
