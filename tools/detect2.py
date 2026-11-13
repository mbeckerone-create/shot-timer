"""Shot detector v2 (reference implementation for the JS AudioWorklet).
Per 1ms block: hp energy (2kHz biquad), full-band energy, adaptive hp noise floor.
Arm when hp energy > floor+ARM_DB. Within CONFIRM_MS look for peak; it's a shot if
peak hp energy > SHOT_DB (absolute) and hp/full ratio > HPFRAC_DB (rejects wind/voice thumps).
Timestamp = first sample in arm block where |hp| > 4x floor rms (sample accurate).
Lockout LOCK_MS after the confirmed peak (merges crack+blast+echo)."""
import numpy as np, glob, os, json, sys
sys.path.insert(0,'analysis'); from detect import load, biquad_hp
P=dict(hp=2000, arm_db=15, shot_db=-26, hpfrac_db=-9, confirm_ms=70, lock_ms=100, floor_ms=300, echo_ms=180, echo_db=6, back_ms=60, back_db=20, tonal=0.6, tonal_gap_ms=60)
def top3(y,c,sr,n=1024):
    seg=y[c-n//4:c-n//4+n]*np.hanning(n); P=np.abs(np.fft.rfft(seg))**2+1e-20
    f=np.fft.rfftfreq(n,1/sr); P=P[(f>=1500)&(f<=16000)]
    return np.sort(P)[-3:].sum()/P.sum()
def detect(x,sr,p=P):
    y=biquad_hp(x,sr,p['hp']); B=sr//1000; n=len(y)//B
    eh=(y[:n*B].reshape(n,B)**2).mean(1)+1e-14; ef=(x[:n*B].reshape(n,B)**2).mean(1)+1e-14
    dh=10*np.log10(eh); df=10*np.log10(ef)
    floor=np.median(dh[:300]); a=1/p['floor_ms']; i=1; shots=[]; lock=0
    while i<n-p['confirm_ms']:
        if i>=lock and dh[i]>floor+p['arm_db']:
            w=dh[i:i+p['confirm_ms']]; pk=int(w.argmax()); j=i+pk
            # hp fraction over 5ms around peak
            hpf=10*np.log10(eh[j-2:j+3].sum()/ef[j-2:j+3].sum())
            if w[pk]>p['shot_db'] and hpf>p['hpfrac_db']:
                k=j
                while k>1 and j-k<p['back_ms'] and dh[k-1]>w[pk]-p['back_db']: k-=1
                thr=max(4*np.sqrt(10**(floor/10)), np.sqrt(10**((w[pk]-p['back_db'])/10)))
                s0=(k-1)*B; seg=y[s0:(j+1)*B]; t=(s0+int(np.argmax(np.abs(seg)>thr)))/sr
                c=int(round(t*sr)); pks=c+int(np.argmax(np.abs(y[c:c+int(0.07*sr)])))
                g=int(p['tonal_gap_ms']*sr/1000)
                if top3(y,pks,sr)>p['tonal'] and (top3(y,pks+g,sr)>p['tonal'] or top3(y,pks-g,sr)>p['tonal']):
                    lock=j+p['lock_ms']; i=lock; continue   # sustained pure tone = a beep, not a shot
                if shots and t-shots[-1]['t']<p['echo_ms']/1000 and w[pk]<shots[-1]['pk']-p['echo_db']:
                    lock=j+p['lock_ms']; i=lock; continue   # echo of previous shot
                shots.append(dict(t=round(t,4),pk=round(float(w[pk]),1),hpf=round(float(hpf),1),dly=pk))
                lock=j+p['lock_ms']; i=lock; continue
            else:
                i+=1; continue
        if i>=lock: floor+=a*(min(dh[i],floor+6)-floor)
        i+=1
    return shots
if __name__=='__main__':
    out={}
    for f in sorted(glob.glob('audio/*.wav')):
        x,sr=load(f); s=detect(x,sr); b=os.path.basename(f)[:-4]; out[b]=s
        print(f"{b}: {len(s)} shots"); print("   "+" ".join(f"{q['t']:.3f}" for q in s))
        sp=[s[k+1]['t']-s[k]['t'] for k in range(len(s)-1)]
    json.dump(out,open('analysis/detections_v2.json','w'),indent=1)
