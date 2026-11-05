# Exports Beat This! (final0.ckpt) with its mel front end to models/beatthis.onnx.
#   pip install torch torchaudio onnx onnxruntime git+https://github.com/CPJKU/beat_this
#   python tools/models/export_beatthis.py ~/Downloads/final0.ckpt
import sys
import numpy as np, torch
from beat_this.inference import load_model
model = load_model(sys.argv[1], device='cpu').eval()
fb = np.fromfile('mac/DJAW/ML/beatthis_fbank_513x128.f32', dtype=np.float32).reshape(513, 128)
class Wrap(torch.nn.Module):
    def __init__(s):
        super().__init__(); s.m = model; s.register_buffer('fb', torch.from_numpy(fb))
    def forward(s, mag):          # mag: [1, T, 513] |STFT| / sqrt(1024)
        x = torch.log1p(1000 * (mag @ s.fb))
        out = s.m(x)
        return out['beat'], out['downbeat']
w = Wrap().eval()
# reference check against beat_this' own LogMelSpect on a signal
from beat_this.preprocessing import LogMelSpect
lms = LogMelSpect()
y = torch.randn(22050 * 20) * 0.1
ref = lms(y)                                        # [T, 128]
spec = torch.stft(y, 1024, 441, window=torch.hann_window(1024), center=True, pad_mode='reflect', return_complex=True).abs().T / 32
mine = torch.log1p(1000 * (spec @ w.fb))
print('mel diff', (ref - mine).abs().max().item(), ref.shape, mine.shape)
T = 1500
dummy = torch.randn(1, T, 513).abs()
with torch.no_grad():
    b, d = w(dummy)
torch.onnx.export(w, (dummy,), 'models/beatthis.onnx', input_names=['mag'], output_names=['beat', 'downbeat'],
                  dynamic_axes={'mag': {1: 'T'}, 'beat': {1: 'T'}, 'downbeat': {1: 'T'}}, opset_version=17, dynamo=False)
import onnxruntime as ort
s = ort.InferenceSession('models/beatthis.onnx')
ob, od = s.run(None, {'mag': dummy.numpy()})
print('onnx diff', np.abs(ob - b.numpy()).max(), np.abs(od - d.numpy()).max(), ob.shape)
