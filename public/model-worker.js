import { EdgesGeometry } from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

self.onmessage = ({ data }) => {
  let geometry;
  let edges;
  try {
    geometry = new STLLoader().parse(data.buffer);
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const positions = geometry.getAttribute("position").array;
    const normals = geometry.getAttribute("normal").array;
    if (!positions.length || !Number.isFinite(geometry.boundingSphere.radius)) throw new Error("The STL contains no valid triangle geometry.");
    // Edge extraction is much more expensive than drawing triangles. Large
    // meshes remain useful as surfaces without allocating millions of edges.
    if (positions.length / 9 <= 50_000) edges = new EdgesGeometry(geometry, 28);
    const edgePositions = edges?.getAttribute("position")?.array;
    const transfer = [positions.buffer, normals.buffer];
    if (edgePositions) transfer.push(edgePositions.buffer);
    self.postMessage({
      positions, normals, edges: edgePositions,
      box: { min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray() },
      sphere: { center: geometry.boundingSphere.center.toArray(), radius: geometry.boundingSphere.radius }
    }, transfer);
  } catch (error) {
    self.postMessage({ error: error.message || "STL parsing failed" });
  } finally {
    edges?.dispose();
    geometry?.dispose();
  }
};
