# Stores the large float32 weights of an ONNX model as float16 (with a Cast back to float32 in the graph),
# halving the file size while the arithmetic stays float32. Keeps files under GitHub's 100 MB limit.
#   python fp16_weights.py in.onnx out.onnx
import sys, onnx, numpy as np
from onnx import numpy_helper, helper, TensorProto

m = onnx.load(sys.argv[1])
g = m.graph
new_inits, casts = [], []
for init in list(g.initializer):
    a = numpy_helper.to_array(init)
    if a.dtype == np.float32 and a.size >= 1024:
        h = numpy_helper.from_array(a.astype(np.float16), init.name + '_fp16')
        new_inits.append(h)
        casts.append(helper.make_node('Cast', [h.name], [init.name], to=TensorProto.FLOAT, name=init.name + '_cast'))
        g.initializer.remove(init)
g.initializer.extend(new_inits)
for n in reversed(casts):
    g.node.insert(0, n)
onnx.checker.check_model(m)
onnx.save(m, sys.argv[2])
print('converted', len(casts), 'tensors')
