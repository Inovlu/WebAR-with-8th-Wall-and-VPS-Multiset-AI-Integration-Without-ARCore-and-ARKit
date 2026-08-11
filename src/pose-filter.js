// Puerto directo de la clase PoseFilter del módulo oficial de Immersal
// (cloud-editor-template/immersal-module.js) — único cambio real: recibe la
// instancia de THREE por parámetro en vez de asumir un global "THREE", para
// poder reusar la copia que ya trae A-Frame (ver comentario grande en
// main.js sobre por qué evitamos una segunda instancia de Three.js).
//
// Qué hace: en vez de aplicar cada localización de MultiSet tal cual llega,
// mantiene un historial de las últimas 8 correcciones (refinePose) y
// promedia posición/orientación descartando outliers (cualquier muestra que
// se aleje más de 1 desvío estándar del resto del historial) — filterAVT
// ("average, variance-trimmed"). Esto absorbe una localización puntual mala
// (confianza baja pero por encima del umbral, o una imagen borrosa) sin que
// se note como un salto en el mundo AR; la corrección final que se aplica
// (this.position / this.rotation) es ese promedio filtrado, no la muestra
// cruda más reciente.
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

  // R: THREE.Matrix4 con la transformación de esta muestra puntual (tracker
  // <- mapa). Se extraen directo de sus elementos la posición (columna 3) y
  // los ejes X/Z (columnas 0/2) — reconstruir la rotación a partir de esos
  // dos ejes filtrados por separado (en vez de promediar cuaterniones, que no
  // es una operación lineal válida) es la misma técnica que usa Immersal.
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
