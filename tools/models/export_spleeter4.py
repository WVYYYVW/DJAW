# Exports Deezer Spleeter 4stems (MIT, release v1.4.0 4stems.tar.gz) to ONNX as DJAW's stem-mask model.
# The same U-Net as export_spleeter.py (2stems), four of them: vocals, drums, bass, other (Spleeter's
# instrument_list order, which is also the order of the nets' variables in the checkpoint).
# Input  magnitude [1, 2, 512, 1024]       (channel, frame, bin): |STFT| (4096 / 1024, periodic Hann, plain DFT scale)
# One ONNX file per stem (converting all four at once needs more memory than tf2onnx has here):
# Output estimate  [1, 2, 512, 1024]       this stem's magnitude estimate yᵢ; the app forms Spleeter's ratio masks
#                                          (yᵢ² + ε/4) / (Σ yⱼ² + ε) from the four.
#   python export_spleeter4.py <checkpoint prefix, e.g. 4stems/model> <out dir>   → stem_vocals.onnx, stem_drums.onnx, …
import sys
import numpy as np
import tensorflow as tf
import tf2onnx

ckpt, outdir = sys.argv[1], sys.argv[2]
r = tf.train.load_checkpoint(ckpt)
W = lambda n: tf.constant(r.get_tensor(n))
EPS = 1e-3

def name(base, k):
    return base if k == 0 else f'{base}_{k}'

def bn(x, k):
    b = name('batch_normalization', k)
    return tf.nn.batch_normalization(x, W(b + '/moving_mean'), W(b + '/moving_variance'), W(b + '/beta'), W(b + '/gamma'), EPS)

def conv(x, k, stride=2, dilation=1):
    c = name('conv2d', k)
    y = tf.nn.conv2d(x, W(c + '/kernel'), strides=stride, padding='SAME', dilations=dilation)
    return y + W(c + '/bias')

def deconv(x, k):
    c = name('conv2d_transpose', k)
    kern = W(c + '/kernel')
    s = tf.shape(x)
    out = tf.stack([s[0], s[1] * 2, s[2] * 2, kern.shape[2]])
    return tf.nn.conv2d_transpose(x, kern, out, strides=2, padding='SAME') + W(c + '/bias')

def unet(x, n):
    # n = index of the net (0 vocals, 1 drums, 2 bass, 3 other): 7 conv2d, 6 conv2d_transpose, 12 batch norms each.
    ck, dk, bk = 7 * n, 6 * n, 12 * n
    lrelu = lambda v: tf.nn.leaky_relu(v, 0.2)
    c1 = conv(x, ck); r1 = lrelu(bn(c1, bk))
    c2 = conv(r1, ck + 1); r2 = lrelu(bn(c2, bk + 1))
    c3 = conv(r2, ck + 2); r3 = lrelu(bn(c3, bk + 2))
    c4 = conv(r3, ck + 3); r4 = lrelu(bn(c4, bk + 3))
    c5 = conv(r4, ck + 4); r5 = lrelu(bn(c5, bk + 4))
    c6 = conv(r5, ck + 5); _ = lrelu(bn(c6, bk + 5))
    u1 = bn(tf.nn.relu(deconv(c6, dk)), bk + 6); m1 = tf.concat([c5, u1], -1)
    u2 = bn(tf.nn.relu(deconv(m1, dk + 1)), bk + 7); m2 = tf.concat([c4, u2], -1)
    u3 = bn(tf.nn.relu(deconv(m2, dk + 2)), bk + 8); m3 = tf.concat([c3, u3], -1)
    u4 = bn(tf.nn.relu(deconv(m3, dk + 3)), bk + 9); m4 = tf.concat([c2, u4], -1)
    u5 = bn(tf.nn.relu(deconv(m4, dk + 4)), bk + 10); m5 = tf.concat([c1, u5], -1)
    u6 = bn(tf.nn.relu(deconv(m5, dk + 5)), bk + 11)
    mask = tf.sigmoid(conv(u6, ck + 6, stride=1, dilation=2))
    return mask * x

import gc, os, onnx, onnxruntime as ort
x = np.abs(np.random.randn(1, 2, 512, 1024)).astype(np.float32)
for n, stem in enumerate(['vocals', 'drums', 'bass', 'other']):
    @tf.function(input_signature=[tf.TensorSpec([1, 2, 512, 1024], tf.float32, name='magnitude')])
    def model(magnitude):
        y = unet(tf.transpose(magnitude, [0, 2, 3, 1]), n)
        return tf.identity(tf.transpose(y, [0, 3, 1, 2]), name='estimate')
    ref = model(tf.constant(x)).numpy()
    dst = os.path.join(outdir, f'stem_{stem}.onnx')
    tf2onnx.convert.from_function(model, input_signature=model.input_signature, opset=17, output_path=dst)
    s = ort.InferenceSession(dst)
    o = s.run(None, {s.get_inputs()[0].name: x})[0]
    print(stem, 'max diff', float(np.abs(o - ref).max()), 'mean', float(ref.mean()), os.path.getsize(dst) // 1048576, 'MB', flush=True)
    del s, model; gc.collect()
