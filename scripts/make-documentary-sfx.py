"""Original procedural documentary accents; no recordings or third-party samples.
Run with Python 3 stdlib. These are stylized accents, not authentic historical recordings.
"""
import math
import random
import struct
import wave
from pathlib import Path

SR = 44100
DURATIONS = {'stamp': .42, 'thud': .65, 'paper': .8, 'explosion': 2.2,
             'train': 2.4, 'map-pin': .32, 'page-turn': .85, 'low-boom': 1.8}
ROOT = Path(__file__).resolve().parent.parent / 'assets' / 'sfx'

for seed, (name, duration) in enumerate(DURATIONS.items(), 70):
    rng = random.Random(seed)
    samples, low = [], 0.
    for i in range(int(SR * duration)):
        t = i / SR
        noise = rng.uniform(-1, 1)
        low += .035 * (noise - low)
        if name in ('stamp', 'thud', 'low-boom', 'explosion'):
            frequency = {'stamp': 130, 'thud': 72, 'low-boom': 44, 'explosion': 37}[name]
            decay = {'stamp': 18, 'thud': 10, 'low-boom': 3.5, 'explosion': 2.8}[name]
            x = math.exp(-decay*t) * (math.sin(2*math.pi*frequency*t - 9*t*t) + low * 3)
            if name == 'explosion':
                x += low * 4 * math.exp(-2.5*t)
        elif name == 'train':
            pulse = max(0, math.cos(2*math.pi*4*t)) ** 14
            x = (low * 4 + noise*.1) * pulse * min(1, t*6) * min(1, (duration-t)*3)
        elif name == 'map-pin':
            x = math.sin(2*math.pi*(680*t-180*t*t))*math.exp(-22*t) + low*math.exp(-30*t)
        else:
            position = t / duration
            x = (noise-low) * math.sin(math.pi*position)**2 * (.25 + .75*math.sin(2*math.pi*17*t)**2)
        attack = min(1, t/.004)
        release = min(1, (duration-t)/.04)
        samples.append(x*attack*release)
    scale = 10**(-3/20) / max(abs(x) for x in samples)
    with wave.open(str(ROOT / (name+'.wav')), 'wb') as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(b''.join(struct.pack('<hh', int(x*scale*32767), int(x*scale*32767)) for x in samples))
    print(name, duration)
