# Compare a session export's strings with the shots audible in the matching training-film clips.
# usage (in a folder holding session.json and clipN.wav, extracted with: ffmpeg -i clipN.mp4 -ac 1 -ar 48000 clipN.wav):
#   python3 check_clips_vs_video.py
# Per string: each real shot on the video (peaks over -8 dBFS) marked K kept / G struck out by the gate / MISS never registered, with the app's dB.
import json, numpy as np, wave, sys
def load(f):
    w=wave.open(f); return np.frombuffer(w.readframes(w.getnframes()),np.int16).astype(np.float32)/32768, w.getframerate()
def shots(a,sr,t0,t1,thr=-8,gap=0.2):
    s=a[int(max(0,t0)*sr):int(t1*sr)]; win=int(.002*sr)
    env=np.sqrt(np.convolve(s*s,np.ones(win)/win,'same')+1e-12); db=20*np.log10(env); out=[]; i=0
    while i<len(db):
        if db[i]>thr: out.append(t0+i/sr); i+=int(gap*sr)
        else: i+=1
    return out
S=json.load(open('session.json')); W={}
tot=dict(truth=0,kept=0,gated=0,missed=0,extra=0)
for r in reversed(S['records']):
    if not r.get('clip'): continue
    c=r['clip'][-5:]
    try:
        if c not in W: W[c]=load(c+'.wav')
    except FileNotFoundError: print(r['clip'],'(video not in folder)'); continue
    a,sr=W[c]; b=r['clipT']; sh=r['shots']; end=max([q['t'] for q in sh]+[3])+1.0
    tr=[t-b for t in shots(a,sr,b+0.3,b+end)]
    # align: offset = median of nearest diffs for kept
    det=[(q['t'],'G' if q.get('removed') else 'K',q['db']) for q in sh]
    diffs=[min(tr,key=lambda x:abs(x-t))-t for t,_,_ in det if tr]; diffs=[x for x in diffs if abs(x)<0.2]; off=float(np.median(diffs)) if diffs else 0.08
    res=[]; used=set()
    for t in tr:
        m=[d for d in det if abs(d[0]+off-t)<0.06]
        if m: res.append(f"{t:5.2f}{m[0][1]}({m[0][2]:.0f})"); used.add(m[0]); tot['kept' if m[0][1]=='K' else 'gated']+=1
        else: res.append(f"{t:5.2f}MISS"); tot['missed']+=1
        tot['truth']+=1
    ex=[d for d in det if d not in used and d[1]=='K']; tot['extra']+=len(ex)
    print(f"{c} {(r.get('drillName') or 'free')[:10]:10} rep{r.get('rep') or '-'} off{off:+.2f} truth{len(tr)}: "+' '.join(res)+ (f"  | EXTRA kept: {[(round(d[0],2),d[2]) for d in ex]}" if ex else ''))
print(tot)
