"""
Add Shadowborn expansion scenes to the draft world.
"""
import re
import json
import subprocess

WORLD_ID = '401e321f-b936-4b5f-acf1-400a619c2c3c'
COOKIE_FILE = '/tmp/sb_cookies.txt'
BASE = 'https://re-newrld.fly.dev'

def req(method, path, body=None):
    cmd = ['curl', '-s', '-b', COOKIE_FILE, '-X', method, f'{BASE}{path}']
    if body is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(body)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return r.returncode, json.loads(r.stdout) if r.stdout.strip() else {}
    except:
        return r.returncode, {'raw': r.stdout[:200]}

def md_to_html(md):
    """Convert markdown to simple HTML paragraphs."""
    html = []
    for para in md.strip().split('\n\n'):
        para = para.strip()
        if not para or para.startswith('*Placement:'):
            continue
        # Handle italics
        para = re.sub(r'\*(.+?)\*', r'<em>\1</em>', para)
        para = para.replace('\n', ' ')
        html.append(f'<p>{para}</p>')
    return '\n'.join(html)

# Load expansion scenes
with open('/home/hatch/workspace/your_files/shadowborn/shadowborn-expansion-full.md') as f:
    content = f.read()

# Parse scenes
scenes = []
for match in re.finditer(r'## Chapter: "(.+?)"\n\n\*(Placement:.*?)\*\n\n(.+?)(?=\n---\n\n## Chapter: |\Z)', content, re.S):
    title = match.group(1)
    placement = match.group(2)
    body = match.group(3).strip()
    scenes.append((title, placement, md_to_html(body)))

print(f"Found {len(scenes)} scenes to add")

# Get existing scenes to determine order
status, existing = req('GET', f'/worlds/{WORLD_ID}/scenes')
if status != 0:
    print(f"Failed to get scenes: {existing}")
    exit(1)

print(f"Existing scenes: {len(existing)}")

# Add each new scene
for title, placement, html in scenes:
    print(f"\nAdding: {title}")
    print(f"  Placement: {placement}")
    status, result = req('POST', f'/worlds/{WORLD_ID}/scenes', {
        'title': title,
        'prose': html,
    })
    if status == 0 and 'sceneId' in result:
        print(f"  ✓ Created: {result['sceneId']}")
    else:
        print(f"  ✗ Failed: {result}")

print("\nDone!")
