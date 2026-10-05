/* 字形の輪郭を点列にし、穴を残して三角形分割した後、凸ポリゴンにまとめる。
 * 剛体を作るまではフォントの座標系で処理する。
 */
window.GlyphGeometry = (() => {
  'use strict';
  const area = (p) =>
    p.reduce((s, a, i) => {
      const b = p[(i + 1) % p.length];
      return s + a.x * b.y - b.x * a.y;
    }, 0) / 2;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

  function contains(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i],
        b = ring[j];
      if (
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
    }
    return inside;
  }

  function simplify(ring, tolerance) {
    const points = ring.filter((v, i) => i === 0 || distance(v, ring[i - 1]) > 0.001);
    if (points.length > 1 && distance(points[0], points[points.length - 1]) < 0.001)
      points.pop();
    let changed = true;
    while (changed && points.length > 3) {
      changed = false;
      for (let i = 0; i < points.length; i++) {
        const previous = points[(i + points.length - 1) % points.length],
          current = points[i],
          next = points[(i + 1) % points.length];
        if (
          Math.abs(cross(previous, current, next)) /
            Math.max(distance(previous, next), 0.001) <
            tolerance &&
          (current.x - previous.x) * (current.x - next.x) +
            (current.y - previous.y) * (current.y - next.y) <=
            0
        ) {
          points.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return points;
  }

  function sampleContours(commands, step, tolerance) {
    const rings = [];
    let ring = [],
      current = { x: 0, y: 0 };
    const finishContour = () => {
      if (ring.length >= 3) {
        const points = simplify(ring, tolerance);
        if (Math.abs(area(points)) > 0.001) rings.push(points);
      }
      ring = [];
    };
    for (const command of commands) {
      if (command.type === 'M') {
        finishContour();
        current = { x: command.x, y: command.y };
        ring.push(current);
      } else if (command.type === 'L') {
        current = { x: command.x, y: command.y };
        ring.push(current);
      } else if (command.type === 'Q' || command.type === 'C') {
        const start = current,
          control1 = { x: command.x1, y: command.y1 },
          end = { x: command.x, y: command.y };
        const control2 = command.type === 'C' ? { x: command.x2, y: command.y2 } : end;
        const segmentCount = Math.max(
          2,
          Math.ceil(
            (distance(start, control1) +
              distance(control1, control2) +
              distance(control2, end)) /
              step,
          ),
        );
        for (let i = 1; i <= segmentCount; i++) {
          const t = i / segmentCount,
            u = 1 - t;
          ring.push(
            command.type === 'Q'
              ? {
                  x: u * u * start.x + 2 * u * t * control1.x + t * t * end.x,
                  y: u * u * start.y + 2 * u * t * control1.y + t * t * end.y,
                }
              : {
                  x:
                    u * u * u * start.x +
                    3 * u * u * t * control1.x +
                    3 * u * t * t * control2.x +
                    t * t * t * end.x,
                  y:
                    u * u * u * start.y +
                    3 * u * u * t * control1.y +
                    3 * u * t * t * control2.y +
                    t * t * t * end.y,
                },
          );
        }
        current = end;
      } else if (command.type === 'Z') finishContour();
    }
    finishContour();
    return rings;
  }

  // 結合後も凸になる隣接パーツだけをまとめる。凹みや穴は埋めない。

  function mergeConvex(polygons, vertices) {
    let changed = true;
    while (changed) {
      changed = false;
      const edges = new Map();
      outer: for (let i = 0; i < polygons.length; i++)
        for (let a = 0; a < polygons[i].length; a++) {
          const polygon = polygons[i],
            edgeStart = polygon[a],
            edgeEnd = polygon[(a + 1) % polygon.length],
            reverseEdgeKey = `${edgeEnd},${edgeStart}`;
          if (edges.has(reverseEdgeKey)) {
            const [j, b] = edges.get(reverseEdgeKey),
              neighbor = polygons[j];
            const merged = [];
            for (let k = 0; k < polygon.length; k++)
              merged.push(polygon[(a + 1 + k) % polygon.length]);
            for (let k = 2; k < neighbor.length; k++)
              merged.push(neighbor[(b + k) % neighbor.length]);
            const points = merged.map((k) => vertices[k]);
            let sign = 0,
              convex = true;
            for (let k = 0; k < points.length; k++) {
              const turn = cross(
                points[k],
                points[(k + 1) % points.length],
                points[(k + 2) % points.length],
              );
              if (Math.abs(turn) < 1e-7) continue;
              if (sign && Math.sign(turn) !== sign) {
                convex = false;
                break;
              }
              sign = Math.sign(turn);
            }
            if (convex && points.length <= 16) {
              polygons[j] = merged;
              polygons.splice(i, 1);
              changed = true;
              break outer;
            }
          } else edges.set(`${edgeStart},${edgeEnd}`, [i, a]);
        }
    }
    return polygons.map((polygon) => polygon.map((i) => ({ ...vertices[i] })));
  }

  function createGlyphGeometry(font, character, config) {
    const glyph = font.charToGlyph(character);
    if (!glyph || glyph.index === 0)
      throw new Error('この文字は現在のフォントでは使用できません');
    // 全文字で同じemスケールを使う。外接矩形に合わせて拡大縮小しない。
    const contours = sampleContours(
      glyph.getPath(0, 0, config.characterScale).commands,
      config.curveSampleStep,
      config.simplifyTolerance,
    );
    if (!contours.length) throw new Error('この文字には積める形状がありません');
    const nodes = contours.map((points) => ({
      points,
      area: Math.abs(area(points)),
      parent: -1,
      depth: 0,
    }));
    nodes.forEach((node, i) => {
      let min = Infinity;
      nodes.forEach((candidate, j) => {
        if (
          i !== j &&
          candidate.area > node.area &&
          candidate.area < min &&
          contains(node.points[0], candidate.points)
        ) {
          node.parent = j;
          min = candidate.area;
        }
      });
    });
    nodes.forEach((node) => {
      let p = node.parent;
      while (p >= 0) {
        node.depth++;
        p = nodes[p].parent;
      }
    });
    const polygons = [];
    let triangleCount = 0;
    nodes.forEach((node, i) => {
      if (node.depth % 2) return;
      const vertices = [...node.points],
        holes = [];
      nodes.forEach((h) => {
        if (h.parent === i && h.depth % 2) {
          holes.push(vertices.length);
          vertices.push(...h.points);
        }
      });
      const flat = vertices.flatMap((p) => [p.x, p.y]);
      const indices = earcut(flat, holes, 2);
      if (earcut.deviation(flat, holes, 2, indices) > 0.001)
        throw new Error('この文字の形状を正しく分割できませんでした');
      const triangles = [];
      for (let k = 0; k < indices.length; k += 3) {
        const t = indices.slice(k, k + 3);
        if (Math.abs(area(t.map((i) => vertices[i]))) > 1e-7) triangles.push(t);
      }
      triangleCount += triangles.length;
      polygons.push(...mergeConvex(triangles, vertices));
    });
    if (!polygons.length) throw new Error('この文字の形状を生成できませんでした');
    return {
      character,
      contours,
      polygons,
      area: polygons.reduce((sum, p) => sum + Math.abs(area(p)), 0),
      holes: nodes.filter((n) => n.depth % 2).length,
      components: nodes.filter((n) => n.depth % 2 === 0).length,
      triangleCount,
    };
  }

  function glyphToMatterBody(geometry, x, y, config) {
    const { Body, Vertices } = Matter;
    const options = {
      friction: config.friction,
      frictionStatic: config.frictionStatic,
      restitution: config.restitution,
      density: config.density,
      frictionAir: config.linearDamping,
      slop: 0.025,
    };
    const parts = geometry.polygons.map((p) =>
      Body.create({
        ...options,
        position: Vertices.centre(p),
        vertices: p.map((v) => ({ ...v })),
      }),
    );
    const body = Body.create({ ...options, parts, label: geometry.character });
    const origin = { ...body.position };
    // 衝突判定と描画がずれないよう、実際の頂点を重心からの相対座標で保存する。
    const collisionParts = body.parts.length > 1 ? body.parts.slice(1) : [body];
    const localPolygons = collisionParts.map((p) =>
      p.vertices.map((v) => ({ x: v.x - origin.x, y: v.y - origin.y })),
    );
    // 共有する辺を内部辺として記録し、パーツの継ぎ目への接触を減らす。
    const edgeKey = (a, b) =>
      [a.x.toFixed(5), a.y.toFixed(5), b.x.toFixed(5), b.y.toFixed(5)].join(',');
    const edgeMap = new Map();
    collisionParts.forEach((p) =>
      p.vertices.forEach((v, i) => {
        const n = p.vertices[(i + 1) % p.vertices.length],
          other = edgeMap.get(edgeKey(n, v));
        if (other) {
          v.isInternal = true;
          other.isInternal = true;
        } else edgeMap.set(edgeKey(v, n), v);
      }),
    );
    // 「川」のように離れた画も考慮するため、平行軸の定理で慣性を補正する。
    // 係数4はMatter.jsの多角形慣性の計算に合わせている。
    if (parts.length > 1)
      Body.setInertia(
        body,
        parts.reduce(
          (s, p) =>
            s +
            p.inertia +
            4 *
              p.mass *
              ((p.position.x - origin.x) ** 2 + (p.position.y - origin.y) ** 2),
          0,
        ),
      );
    if (config.massExponent !== 1)
      Body.setMass(
        body,
        config.density *
          config.massReferenceArea *
          (geometry.area / config.massReferenceArea) ** config.massExponent,
      );
    body.plugin.glyph = { geometry, localPolygons };
    Body.setPosition(body, { x, y });
    return body;
  }
  return { createGlyphGeometry, glyphToMatterBody, area, contains };
})();
