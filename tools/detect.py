"""Shot detector v1 — designed to port 1:1 to JS AudioWorklet.
Pipeline: 2nd-order high-pass (biquad) -> 0.5ms block energy -> adaptive floor -> trigger
-> sample-accurate onset backtrack -> echo/refractory rejection."""
import numpy as np, wave, glob, os, json, sys
def load(p):
    w=wave.open(p); sr=w.getframerate(); x=np.frombuffer(w.readframes(w.getnframes()),np.int16).astype(np.float64)/32768; return x,sr
def biquad_hp(x,sr,fc,q=0.7071):
    w0=2*np.pi*fc/sr; a=np.sin(w0)/(2*q); c=np.cos(w0)
    b0=(1+c)/2; b1=-(1+c); b2=(1+c)/2; a0=1+a; a1=-2*c; a2=1-a
    from scipy.signal import lfilter
    return lfilter([b0/a0,b1/a0,b2/a0],[1,a1/a0,a2/a0],x)
P=dict(hp=2000, block_ms=0.5, ratio_db=22, min_db=-40, refractory_ms=60, echo_ms=180, echo_ratio_db=-8, rise_ms=3)
def detect(x,sr,p=P):
    y=biquad_hp(x,sr,p['hp'])
    B=max(1,int(sr*p['block_ms']/1000)); n=len(y)//B
    e=(y[:n*B].reshape(n,B)**2).mean(1)+1e-14
    edb=10*np.log10(e)
    floor=edb[:200].mean(); alpha=1/ (200/p['block_ms'])  # ~200ms EMA
    shots=[]; hold_until=-1; last_peak=-999; last_t=-1e9
    i=0
    while i<n:
        d=edb[i]
        if i>=hold_until and d>floor+p['ratio_db'] and d>p['min_db']:
            # peak within next rise window
            w=int(p['rise_ms']/p['block_ms']); seg=edb[i:i+w+1]; pk=seg.max(); pi=i+seg.argmax()
            # sample-accurate onset: first sample in [i-2 blocks, pk] where |y|>=0.2*peak abs
            s0=max(0,(i-2)*B); s1=(pi+1)*B
            amp=np.abs(y[s0:s1]); thr=0.2*amp.max(); on=s0+np.argmax(amp>=thr)
            t=on/sr; dt=(t-last_t)*1000
            is_echo = dt<p['echo_ms'] and pk<last_peak+p['echo_ratio_db']
            if not is_echo:
                shots.append(dict(t=round(t,4),db=round(float(pk),1),floor=round(float(floor),1)))
                last_t=t; last_peak=pk
            hold_until=i+int(p['refractory_ms']/p['block_ms'])
            i+=1; continue
        if i>=hold_until: floor+= alpha*(d-floor)
        i+=1
    return shots
if __name__=='__main__':
    out={}
    for f in sorted(glob.glob('audio/*.wav')):
        x,sr=load(f); s=detect(x,sr); b=os.path.basename(f)[:-4]; out[b]=s
        ts=[q['t'] for q in s]
        print(f"{b}: {len(s)} shots")
        print("   "+" ".join(f"{q['t']:.3f}({q['db']:.0f}/{q['floor']:.0f})" for q in s))
    json.dump(out,open('analysis/detections_v1.json','w'),indent=1)
