# Exports CUE-DETR (ETH-DISCO, MIT; weights disco-eth/cue-detr model.safetensors) to ONNX.
# Input  pixel_values [B, 3, 128, 355] (viridis spectrogram image, ImageNet-normalised, see NeuralAnalyzer.swift)
# Output score [B, 100] = softmax(logits)[..., 0] (DetrImageProcessor.post_process_object_detection, 1 class)
#        boxes [B, 100, 4] = (cx, cy, w, h), 0…1
#   python export_cuedetr.py model.safetensors cuedetr.onnx
import sys, torch
from safetensors.torch import load_file
from transformers import DetrConfig, DetrForObjectDetection

src, dst = sys.argv[1], sys.argv[2]
cfg = DetrConfig(use_timm_backbone=True, backbone='resnet50', use_pretrained_backbone=False, num_labels=1)
model = DetrForObjectDetection(cfg)
state = load_file(src)
missing, unexpected = model.load_state_dict(state, strict=False)
print('missing', missing, 'unexpected', unexpected)
model.eval()

class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__(); self.m = m
    def forward(self, pixel_values):
        mask = torch.ones(pixel_values.shape[0], pixel_values.shape[2], pixel_values.shape[3], dtype=torch.long)
        out = self.m(pixel_values=pixel_values, pixel_mask=mask)
        return out.logits.softmax(-1)[..., 0], out.pred_boxes

w = Wrap(model)
x = torch.randn(2, 3, 128, 355)
with torch.no_grad():
    ref = w(x)
torch.onnx.export(w, (x,), dst, input_names=['pixel_values'], output_names=['score', 'boxes'],
                  dynamic_axes={'pixel_values': {0: 'batch'}, 'score': {0: 'batch'}, 'boxes': {0: 'batch'}}, opset_version=17)
import onnxruntime as ort, numpy as np
s = ort.InferenceSession(dst)
o = s.run(None, {'pixel_values': x.numpy()})
print('max diff', np.abs(o[0] - ref[0].numpy()).max(), np.abs(o[1] - ref[1].numpy()).max())
