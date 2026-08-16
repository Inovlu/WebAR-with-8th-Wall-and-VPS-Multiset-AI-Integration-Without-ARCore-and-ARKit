// Direct port of the PoseFilter class from the official Immersal module
// (cloud-editor-template/immersal-module.js) — only real change: receives
// the THREE instance as a parameter instead of assuming a "THREE" global,
// so we can reuse the copy that A-Frame already ships (see the long comment
// in main.js about why we avoid a second Three.js instance).
//
// What it does: instead of applying each MultiSet localization as-is, it
// maintains a history of the last 8 corrections (refinePose) and averages
// position/orientation while discarding outliers (any sample more than 1
// standard deviation from the rest of the history) — filterAVT ("average,
// variance-trimmed"). This absorbs a single bad localization (low confidence
// but above threshold, or a blurry image) without it appearing as a jump in
// the AR world; the final correction applied (this.position / this.rotation)
// is that filtered average, not the most recent raw sample.
export class PoseFilter {
  constructor(THREE) {
    this.THREE = THREE;
    this.position = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();

    this.mHistorySize = 8;
    this.mP = new Array(this.mHistorySize).fill().map(() => new THREE.Vector3());
    this.mX = new Array(this.mHistorySize).fill().map(() => new THREE.Vector3());
    this.mZ = new Array(this.mHistorySize).fill().map(() => new THREE.Vector3());
    this.mSamples = 0;
  }

  sampleCount() {
    return this.mSamples;
  }

  invalidateHistory() {
    this.mSamples = 0;
  }

  resetFiltering() {
    this.position.set(0, 0, 0);
    this.rotation.identity();
    this.invalidateHistory();
  }

  // R: THREE.Matrix4 with the transformation for this particular sample
  // (tracker ← map). Position (column 3) and the X/Z axes (columns 0/2)
  // are extracted directly from its elements — reconstructing the rotation
  // from those two axes filtered separately (instead of averaging
  // quaternions, which is not a valid linear operation) is the same
  // technique Immersal uses.
  refinePose(R) {
    const { THREE } = this;
    const idx = this.mSamples % this.mHistorySize;
    const els = R.elements;
    this.mP[idx].set(els[0 + 3 * 4], els[1 + 3 * 4], els[2 + 3 * 4]);
    this.mX[idx].set(els[0 + 0 * 4], els[1 + 0 * 4], els[2 + 0 * 4]);
    this.mZ[idx].set(els[0 + 2 * 4], els[1 + 2 * 4], els[2 + 2 * 4]);
    this.mSamples++;

    const n = this.mSamples > this.mHistorySize ? this.mHistorySize : this.mSamples;
    this.position = this.filterAVT(this.mP, n);
    const x = this.filterAVT(this.mX, n).normalize();
    const z = this.filterAVT(this.mZ, n).normalize();
    const up = new THREE.Vector3().crossVectors(z, x).normalize();
    this.rotation.setFromRotationMatrix(new THREE.Matrix4().lookAt(z, new THREE.Vector3(), up));
  }

  filterAVT(buf, n) {
    const { THREE } = this;
    const mean = new THREE.Vector3();
    for (let i = 0; i < n; i++) mean.add(buf[i]);
    mean.divideScalar(n);
    if (n <= 2) return mean;

    let variance = 0;
    for (let i = 0; i < n; i++) variance += buf[i].distanceToSquared(mean);
    variance /= n;

    const avg = new THREE.Vector3();
    let included = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i].distanceToSquared(mean) <= variance) {
        avg.add(buf[i]);
        included++;
      }
    }
    if (included > 0) {
      avg.divideScalar(included);
      return avg;
    }
    return mean;
  }
}
