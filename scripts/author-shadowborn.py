#!/usr/bin/env python3
"""Author the Shadowborn interactive world into Re:NeWrld via the live API."""
import re, json, sys, os
import urllib.request, urllib.error, http.cookiejar

BASE = 'https://re-newrld.fly.dev'
API = BASE  # routes mounted at root, no /api/v1 prefix

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def req(method, path, data=None):
    url = API + path
    body = json.dumps(data).encode() if data else None
    r = urllib.request.Request(url, data=body, method=method,
        headers={'Content-Type': 'application/json'})
    try:
        with opener.open(r) as resp:
            return resp.status, json.loads(resp.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}')

def md_to_html(md_text):
    paras = [p.strip() for p in re.split(r'\n\n+', md_text.strip()) if p.strip()]
    out = []
    for p in paras:
        if p.startswith('[') and p.endswith(']'):
            continue
        p = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', p)
        p = p.replace('\n', ' ')
        out.append(f'<p>{p}</p>')
    return '\n'.join(out)

# ---- Load book ----
with open('/home/hatch/workspace/your_files/shadowborn/shadowborn-book.md') as f:
    book = f.read()
with open('/home/hatch/workspace/your_files/shadowborn/shadowborn-new-scenes.md') as f:
    new_scenes = f.read()

def extract_chapter(book, num):
    m = re.search(rf'^# Chapter {num} —[^\n]*\n(.*?)(?=^---\s*$|^# (?:Chapter|Interlude))',
                  book, flags=re.M | re.S)
    return m.group(1).strip() if m else ''

def extract_interlude(book):
    m = re.search(r'^# Interlude —[^\n]*\n(.*?)(?=^---\s*$|^# Chapter)',
                  book, flags=re.M | re.S)
    return m.group(1).strip() if m else ''

def extract_new_scene(text, title):
    m = re.search(rf'^## Scene: "{re.escape(title)}".*?\n(.*?)(?=^---\s*$|^## Scene:)',
                  text, flags=re.M | re.S)
    if not m:
        return ''
    body = m.group(1).strip()
    # Remove the [Uses...] direction line and [Ending] marker
    body = re.sub(r'^\[Uses.*?\]\s*', '', body, flags=re.M).strip()
    body = re.sub(r'^\*\*\[Ending:.*?\]\*\*\s*$', '', body, flags=re.M).strip()
    return body

# Chapter 10 split
ch10 = extract_chapter(book, 10)
split_marker = "Break it, and the caldera's shadow will wake"
split_idx = ch10.find(split_marker)
offer_text = ch10[:split_idx].strip()
refuse_marker = '"What happens," he asked slowly'
refuse_idx = ch10.find(refuse_marker)
refuse_text = ch10[refuse_idx:].strip()

# Remove trailing choice-hint paragraph from offer if present
offer_text = re.sub(r'\n\nOne broken seal\. That\'s all it asked\.$', '', offer_text).strip()

SCENES = [
    ('The Man Who Wasted Everything', extract_chapter(book, 1), False),
    ('First Breath', extract_chapter(book, 2), False),
    ('The Language of Shadows', extract_chapter(book, 3), False),
    ('Silent Weaving', extract_chapter(book, 4), False),
    ('Master Yumi', extract_chapter(book, 5), False),
    ('The Pale One', extract_chapter(book, 6), False),
    ('The Umbral Trials', extract_chapter(book, 7), False),
    ("Yumi's Door", extract_interlude(book), False),
    ('Ash Falls', extract_chapter(book, 8), False),
    ('The Door Holds', extract_new_scene(new_scenes, 'The Door Holds'), True),
    ('The Long Road', extract_chapter(book, 9), False),
    ("The Pale One's Offer", offer_text, False),
    ('The City Sleeps', extract_new_scene(new_scenes, 'The City Sleeps'), True),
    ('What the Shadow Remembers', refuse_text, True),
]

print(f"Loaded {len(SCENES)} scenes")

# ---- Auth ----
# SECURITY (2026-10-16 audit): credentials come from environment, never hardcoded.
# Set SHADOWBORN_PASSWORD before running. Rotate the account password if exposed.
email = 'shadowborn-author@example.com'
password = os.environ.get('SHADOWBORN_PASSWORD')
if not password:
    sys.exit('SHADOWBORN_PASSWORD environment variable is required')
status, out = req('POST', '/auth/register', {
    'email': email, 'password': password, 'role': 'creator'
})
if status == 201:
    print(f"Registered creator: {email}")
elif status in (400, 409):
    status, out = req('POST', '/auth/login', {'email': email, 'password': password})
    if status == 200:
        print(f"Logged in as: {email}")
    else:
        print(f"LOGIN FAILED: {status} {out}"); sys.exit(1)
else:
    print(f"REGISTER FAILED: {status} {out}"); sys.exit(1)

# ---- Create world ----
status, world = req('POST', '/worlds', {
    'title': 'Shadowborn: A Second Life in the Ashen Veil',
    'description': 'A reincarnated shut-in gets a second life in a world of shadow-weaving ninja clans. Inspired by Naruto and Mushoku Tensei. Your choices shape Kaito\'s courage, his debts to a dream-god, and the fate of a city.',
})
if status != 201:
    print(f"WORLD CREATE FAILED: {status} {world}"); sys.exit(1)
world_id = world['id']
print(f"World created: {world_id}")

# ---- Create scenes ----
import uuid
scene_ids = {}
for title, md_text, is_ending in SCENES:
    html = md_to_html(md_text)
    status, scene = req('POST', f'/worlds/{world_id}/scenes', {
        'chapterId': str(uuid.uuid4()),
        'title': title,
        'prose': html,
        'isEnding': is_ending,
    })
    if status != 201:
        print(f"SCENE FAILED '{title}': {status} {scene}"); sys.exit(1)
    scene_ids[title] = scene['sceneId']
    print(f"  Scene: {title} ({len(html)} chars)")

# ---- Create choices ----
# (from_scene, text, to_scene, mutations, conditions)
CHOICES = [
    ('The Pale One', "Take the Pale One's advice",
     'The Umbral Trials', [{'op': 'inc', 'var': 'pale_trust', 'by': 1}], None),
    ('The Pale One', 'Refuse the dream',
     'The Umbral Trials', None, None),
    ('The Umbral Trials', 'Investigate what happens to failures',
     "Yumi's Door", [{'op': 'set', 'var': 'knows_wardens', 'value': True}], None),
    ('The Umbral Trials', 'Celebrate the victory',
     "Yumi's Door", None, None),
    ("Yumi's Door", 'Keep running',
     'Ash Falls', None, None),
    ('Ash Falls', 'Run — follow the riverbed',
     'The Long Road', None, None),
    ('Ash Falls', 'Stay and hold the door',
     'The Door Holds', None, None),
    ('The Long Road', 'Step forward',
     "The Pale One's Offer", [{'op': 'set', 'var': 'courage', 'value': True}], None),
    ('The Long Road', 'Freeze',
     "The Pale One's Offer", None, None),
    ("The Pale One's Offer", 'Break the seal',
     'The City Sleeps', None, None),
    ("The Pale One's Offer", 'Refuse — and mean it',
     'What the Shadow Remembers', None,
     {'op': 'eq', 'var': 'courage', 'value': True}),
]

for i, (frm, text, to, muts, conds) in enumerate(CHOICES):
    payload = {
        'sceneId': scene_ids[frm],
        'targetSceneId': scene_ids[to],
        'text': text,
        'sortOrder': i,
    }
    if muts: payload['mutations'] = muts
    if conds: payload['conditions'] = conds
    status, choice = req('POST', f'/worlds/{world_id}/choices', payload)
    if status != 201:
        print(f"CHOICE FAILED '{text}': {status} {choice}"); sys.exit(1)
    print(f"  Choice: {frm} → {to}: {text[:40]}")

# ---- Publish ----
url = API + f'/worlds/{world_id}/publish'
r = urllib.request.Request(url, data=None, method='POST')
try:
    with opener.open(r) as resp:
        status, result = resp.status, json.loads(resp.read().decode() or '{}')
except urllib.error.HTTPError as e:
    status, result = e.code, json.loads(e.read().decode() or '{}')
print(f"\nPublish: {status} {json.dumps(result)[:200]}")

if status == 200:
    print(f"\n✅ SHADOWBORN IS LIVE — world id {world_id}")
else:
    print(f"\n❌ Publish failed"); sys.exit(1)
