// A locally patched copy of three.js's SimplifyModifier
// (three/addons/modifiers/SimplifyModifier.js), extended to also carry
// secondary UV sets (glTF's TEXCOORD_1/2/3, three's 'uv1'/'uv2'/'uv3')
// through edge-collapse decimation.
//
// The stock modifier hardcodes its attribute whitelist to
// 'position'/'uv'/'normal'/'tangent'/'color' — anything else, including a
// secondary UV set, gets silently deleted before simplification even
// starts (see its own `for (const name in attributes)` loop). A texture
// bound to one of those (not unheard of — some export pipelines put a
// base color or other map on a non-zero UV set, e.g. baked lightmaps) then
// re-exports referencing a UV channel that no longer exists on the
// decimated geometry, rendering solid black or garbled — see
// modelOptimizer.js's own history with this. Rather than skip
// simplification entirely for a mesh that happens to use one (trading
// away real file-size savings and, at scale, degrading how many products
// a landlet can hold before it gets sluggish), this teaches the same
// edge-collapse algorithm to treat each extra UV set exactly like the
// primary one: keep it, interpolate it the same crude "collapsed vertex
// inherits its neighbor's value" way the original already does for uv,
// normal, and color, and re-emit it under its own attribute name.
//
// Everything below is a straight copy of the original except the lines
// marked "EXTRA UV" — kept structurally identical on purpose so future
// upstream fixes are easy to diff in by hand.
import {
	BufferGeometry,
	Color,
	Float32BufferAttribute,
	Vector2,
	Vector3,
	Vector4
} from 'three';
import { mergeVerticesSteps } from './mergeVerticesSteps.js'; // SLICED: the stock mergeVertices, as steps

const _cb = new Vector3(), _ab = new Vector3();

const EXTRA_UV_NAMES = ['uv1', 'uv2', 'uv3']; // EXTRA UV

// SLICED (#3483): how many vertices or faces the setup and output loops handle
// between yields. The collapse loop yields after every collapse: each one scans
// every remaining vertex for the cheapest edge, so a step is already the cost of
// a pass over the mesh, and a yield costs nothing next to it.
const SLICE_ITEMS = 512;

class SimplifyModifier {

	// SLICED (#3483): the whole algorithm as a generator that yields between small
	// pieces of work, so a caller with a per-frame budget (src/modelTiers.js) can
	// run it across frames instead of in one task of seconds on a large mesh.
	// Returns the simplified geometry, exactly what modify() returns.
	*modifySteps( geometry, count, options = {} ) {

		geometry = geometry.clone();

		delete geometry.morphAttributes.position;
		delete geometry.morphAttributes.normal;
		const attributes = geometry.attributes;

		for ( const name in attributes ) {

			if ( name !== 'position' && name !== 'uv' && name !== 'normal' && name !== 'tangent' && name !== 'color' && ! EXTRA_UV_NAMES.includes( name ) ) geometry.deleteAttribute( name ); // EXTRA UV

		}

		geometry = yield* mergeVerticesSteps( geometry ); // SLICED

		const vertices = [];
		const faces = [];

		const positionAttribute = geometry.getAttribute( 'position' );
		const uvAttribute = geometry.getAttribute( 'uv' );
		const normalAttribute = geometry.getAttribute( 'normal' );
		const tangentAttribute = geometry.getAttribute( 'tangent' );
		const colorAttribute = geometry.getAttribute( 'color' );
		const extraUvAttributes = EXTRA_UV_NAMES.map( ( name ) => geometry.getAttribute( name ) ); // EXTRA UV

		let t = null;
		let v2 = null;
		let nor = null;
		let col = null;

		for ( let i = 0; i < positionAttribute.count; i ++ ) {

			const v = new Vector3().fromBufferAttribute( positionAttribute, i );
			if ( uvAttribute ) {

				v2 = new Vector2().fromBufferAttribute( uvAttribute, i );

			}

			if ( normalAttribute ) {

				nor = new Vector3().fromBufferAttribute( normalAttribute, i );

			}

			if ( tangentAttribute ) {

				t = new Vector4().fromBufferAttribute( tangentAttribute, i );

			}

			if ( colorAttribute ) {

				col = new Color().fromBufferAttribute( colorAttribute, i );

			}

			// EXTRA UV start
			const extraUv = extraUvAttributes.map( ( attr ) => (attr ? new Vector2().fromBufferAttribute( attr, i ) : null) );
			// EXTRA UV end

			const vertex = new Vertex( v, v2, nor, t, col, extraUv ); // EXTRA UV
			vertices.push( vertex );
			if ( i % SLICE_ITEMS === SLICE_ITEMS - 1 ) yield; // SLICED

		}

		let index = geometry.getIndex();

		if ( index !== null ) {

			for ( let i = 0; i < index.count; i += 3 ) {

				const a = index.getX( i );
				const b = index.getX( i + 1 );
				const c = index.getX( i + 2 );

				const triangle = new Triangle( vertices[ a ], vertices[ b ], vertices[ c ], a, b, c );
				faces.push( triangle );
				if ( faces.length % SLICE_ITEMS === 0 ) yield; // SLICED

			}

		} else {

			for ( let i = 0; i < positionAttribute.count; i += 3 ) {

				const a = i;
				const b = i + 1;
				const c = i + 2;

				const triangle = new Triangle( vertices[ a ], vertices[ b ], vertices[ c ], a, b, c );
				faces.push( triangle );
				if ( faces.length % SLICE_ITEMS === 0 ) yield; // SLICED

			}

		}

		// #3528: a vertex that shares its position with another one (a UV or
		// normal seam keeps both copies after the merge) is locked: it is never
		// collapsed away. Collapsing the two copies independently moves one side
		// of the seam and not the other, which opens a crack (a hole) in a closed
		// model; a toilet's mid version had more than half its edges on cracks.
		yield* markSeamVertices( vertices ); // SLICED

		// #4114: optionally, a vertex on an open edge (the border of a patch, or of a hole) is locked too.
		// A model that is a patchwork of pieces meeting at their borders (a scanned brick: 52 pieces, 2,450
		// open edges) loses surface when each piece is simplified alone, because collapsing a border vertex
		// pulls the piece's border back and the gaps between pieces open into holes (12% of the brick's
		// surface at its mid version). Locked, the borders stay where they are and only the inside of a
		// piece is simplified.
		if ( options.lockBorders ) yield* markBorderVertices( vertices, faces ); // SLICED

		// #4302: or, instead of locking them, let a border vertex slide along its border: it may collapse onto the
		// next vertex of the same border while the border stays within a tolerance of where it was, and nothing
		// else may move it. A model whose border is most of its vertices (the brick: 2,507 open edges) cannot
		// get below the interior's own triangle count with the borders locked (2,638 of 5,320), and tears when
		// they are free (#4114). options.slideBorders is the tolerance as a length in this geometry's own units:
		// no original border point may end up further than that from the border that replaces it, however many
		// vertices were collapsed into it (see computeSlidingBorderCost).
		if ( options.slideBorders > 0 && ! options.lockBorders ) yield* markSlidingBorderVertices( vertices, faces, options.slideBorders ); // SLICED

		for ( let i = 0, il = vertices.length; i < il; i ++ ) {

			computeEdgeCostAtVertex( vertices[ i ] );
			if ( i % SLICE_ITEMS === SLICE_ITEMS - 1 ) yield; // SLICED

		}

		// SLICED (#3483): `count` may be a function of the number of vertices left
		// after merging, which is the unit this algorithm works in; it returns how
		// many to remove, and nothing to remove means nothing to return.
		if ( typeof count === 'function' ) {

			count = count( vertices.length );
			if ( count <= 0 ) return null;

		}

		let nextVertex;

		let z = count;

		while ( z -- ) {

			nextVertex = minimumCostEdge( vertices );

			if ( ! nextVertex ) {

				console.log( 'THREE.SimplifyModifier: No next vertex' );
				break;

			}

			// #3528: everything left is a locked seam vertex; stop short of the
			// target rather than tear the mesh.
			if ( nextVertex.collapseCost === Infinity ) break;

			// #4302: a sliding border vertex's cost was worked out when it was last recomputed, and only the
			// neighbours of a collapsed vertex are recomputed after one: the border it stands on may have
			// changed since (a rim of four joined to a rim of two). Work it out again now; if it changed,
			// choose again, without using up a collapse.
			if ( nextVertex.border ) {

				const cost = nextVertex.collapseCost;
				const neighbor = nextVertex.collapseNeighbor;
				computeSlidingBorderCost( nextVertex );

				if ( nextVertex.collapseCost !== cost || nextVertex.collapseNeighbor !== neighbor ) {

					z ++;
					continue;

				}

			}

			collapse( vertices, faces, nextVertex, nextVertex.collapseNeighbor );
			yield; // SLICED

		}

		const simplifiedGeometry = new BufferGeometry();
		const position = [];
		const uv = [];
		const normal = [];
		const tangent = [];
		const color = [];
		const extraUv = EXTRA_UV_NAMES.map( () => [] ); // EXTRA UV

		index = [];

		for ( let i = 0; i < vertices.length; i ++ ) {

			const vertex = vertices[ i ];
			position.push( vertex.position.x, vertex.position.y, vertex.position.z );
			if ( vertex.uv ) {

				uv.push( vertex.uv.x, vertex.uv.y );

			}

			if ( vertex.normal ) {

				normal.push( vertex.normal.x, vertex.normal.y, vertex.normal.z );

			}

			if ( vertex.tangent ) {

				tangent.push( vertex.tangent.x, vertex.tangent.y, vertex.tangent.z, vertex.tangent.w );

			}

			if ( vertex.color ) {

				color.push( vertex.color.r, vertex.color.g, vertex.color.b );

			}

			// EXTRA UV start
			for ( let u = 0; u < EXTRA_UV_NAMES.length; u ++ ) {

				const value = vertex.extraUv[ u ];
				if ( value ) extraUv[ u ].push( value.x, value.y );

			}
			// EXTRA UV end

			vertex.id = i;
			if ( i % SLICE_ITEMS === SLICE_ITEMS - 1 ) yield; // SLICED

		}

		for ( let i = 0; i < faces.length; i ++ ) {

			const face = faces[ i ];
			index.push( face.v1.id, face.v2.id, face.v3.id );
			if ( i % SLICE_ITEMS === SLICE_ITEMS - 1 ) yield; // SLICED

		}

		simplifiedGeometry.setAttribute( 'position', new Float32BufferAttribute( position, 3 ) );
		if ( uv.length > 0 ) simplifiedGeometry.setAttribute( 'uv', new Float32BufferAttribute( uv, 2 ) );
		if ( normal.length > 0 ) simplifiedGeometry.setAttribute( 'normal', new Float32BufferAttribute( normal, 3 ) );
		if ( tangent.length > 0 ) simplifiedGeometry.setAttribute( 'tangent', new Float32BufferAttribute( tangent, 4 ) );
		if ( color.length > 0 ) simplifiedGeometry.setAttribute( 'color', new Float32BufferAttribute( color, 3 ) );
		// EXTRA UV start
		for ( let u = 0; u < EXTRA_UV_NAMES.length; u ++ ) {

			if ( extraUv[ u ].length > 0 ) simplifiedGeometry.setAttribute( EXTRA_UV_NAMES[ u ], new Float32BufferAttribute( extraUv[ u ], 2 ) );

		}
		// EXTRA UV end

		simplifiedGeometry.setIndex( index );

		return simplifiedGeometry;

	}

	// The original entry point: runs the steps above to completion in one go.
	modify( geometry, count ) {

		const steps = this.modifySteps( geometry, count );

		for ( ;; ) {

			const step = steps.next();
			if ( step.done ) return step.value;

		}

	}

}

function pushIfUnique( array, object ) {

	if ( array.indexOf( object ) === - 1 ) array.push( object );

}

function removeFromArray( array, object ) {

	const k = array.indexOf( object );
	if ( k > - 1 ) array.splice( k, 1 );

}

function computeEdgeCollapseCost( u, v ) {

	const edgelength = v.position.distanceTo( u.position );
	let curvature = 0;

	const sideFaces = [];

	for ( let i = 0, il = u.faces.length; i < il; i ++ ) {

		const face = u.faces[ i ];

		if ( face.hasVertex( v ) ) {

			sideFaces.push( face );

		}

	}

	for ( let i = 0, il = u.faces.length; i < il; i ++ ) {

		let minCurvature = 1;
		const face = u.faces[ i ];

		for ( let j = 0; j < sideFaces.length; j ++ ) {

			const sideFace = sideFaces[ j ];
			const dotProd = face.normal.dot( sideFace.normal );
			minCurvature = Math.min( minCurvature, ( 1.001 - dotProd ) / 2 );

		}

		curvature = Math.max( curvature, minCurvature );

	}

	const borders = 0;

	if ( sideFaces.length < 2 ) {

		curvature = 1;

	}

	const amt = edgelength * curvature + borders;

	return amt;

}

// #3528: marks every vertex whose position is shared with another vertex.
// Positions are compared within a hundred-thousandth of the model's own size.
function* markSeamVertices( vertices ) {

	if ( vertices.length === 0 ) return;

	const min = new Vector3( Infinity, Infinity, Infinity );
	const max = new Vector3( - Infinity, - Infinity, - Infinity );

	for ( let i = 0; i < vertices.length; i ++ ) {

		min.min( vertices[ i ].position );
		max.max( vertices[ i ].position );

	}

	const cell = Math.max( min.distanceTo( max ) * 1e-5, 1e-9 );
	const first = new Map();

	for ( let i = 0; i < vertices.length; i ++ ) {

		const p = vertices[ i ].position;
		const key = Math.round( p.x / cell ) + ',' + Math.round( p.y / cell ) + ',' + Math.round( p.z / cell );
		const other = first.get( key );

		if ( other === undefined ) {

			first.set( key, vertices[ i ] );

		} else {

			other.locked = true;
			vertices[ i ].locked = true;

		}

		if ( i % SLICE_ITEMS === SLICE_ITEMS - 1 ) yield; // SLICED

	}

}

// #4114: locks every vertex that lies on an edge used by exactly one triangle, with vertices that share a
// position counted as one (so a seam that only splits UVs or normals is not a border). Positions are compared
// within a hundred-thousandth of the model's own size, the same tolerance as markSeamVertices.
function* markBorderVertices( vertices, faces ) {

	if ( vertices.length === 0 || faces.length === 0 ) return;

	const min = new Vector3( Infinity, Infinity, Infinity );
	const max = new Vector3( - Infinity, - Infinity, - Infinity );

	for ( let i = 0; i < vertices.length; i ++ ) {

		min.min( vertices[ i ].position );
		max.max( vertices[ i ].position );

	}

	const cell = Math.max( min.distanceTo( max ) * 1e-5, 1e-9 );
	const ids = new Map();
	const idOf = ( v ) => {

		const p = v.position;
		const key = Math.round( p.x / cell ) + ',' + Math.round( p.y / cell ) + ',' + Math.round( p.z / cell );
		let id = ids.get( key );
		if ( id === undefined ) {

			id = ids.size;
			ids.set( key, id );

		}

		return id;

	};

	const uses = new Map();

	for ( let i = 0; i < faces.length; i ++ ) {

		const a = idOf( faces[ i ].v1 );
		const b = idOf( faces[ i ].v2 );
		const c = idOf( faces[ i ].v3 );

		if ( a !== b && b !== c && a !== c ) {

			for ( const [ x, y ] of [ [ a, b ], [ b, c ], [ c, a ] ] ) {

				const key = x < y ? x + '-' + y : y + '-' + x;
				const entry = uses.get( key );
				if ( entry ) entry.n ++; else uses.set( key, { n: 1, a: x, b: y } );

			}

		}

		if ( i % SLICE_ITEMS === SLICE_ITEMS - 1 ) yield; // SLICED

	}

	const border = new Set();

	for ( const { n, a, b } of uses.values() ) {

		if ( n === 1 ) {

			border.add( a );
			border.add( b );

		}

	}

	for ( let i = 0; i < vertices.length; i ++ ) {

		if ( border.has( idOf( vertices[ i ] ) ) ) vertices[ i ].locked = true;
		if ( i % SLICE_ITEMS === SLICE_ITEMS - 1 ) yield; // SLICED

	}

}

// #4302: marks every vertex on an open edge (positions welded as in markBorderVertices) as a border vertex that
// may slide along its border, with the deviation it may cause: `tolerance`, a length in the geometry's units.
function* markSlidingBorderVertices( vertices, faces, tolerance ) {

	if ( vertices.length === 0 || faces.length === 0 ) return;

	const min = new Vector3( Infinity, Infinity, Infinity );
	const max = new Vector3( - Infinity, - Infinity, - Infinity );

	for ( let i = 0; i < vertices.length; i ++ ) {

		min.min( vertices[ i ].position );
		max.max( vertices[ i ].position );

	}

	const diagonal = min.distanceTo( max );
	const cell = Math.max( diagonal * 1e-5, 1e-9 );
	const ids = new Map();
	const idOf = ( v ) => {

		const p = v.position;
		const key = Math.round( p.x / cell ) + ',' + Math.round( p.y / cell ) + ',' + Math.round( p.z / cell );
		let id = ids.get( key );
		if ( id === undefined ) {

			id = ids.size;
			ids.set( key, id );

		}

		return id;

	};

	const uses = new Map();

	for ( let i = 0; i < faces.length; i ++ ) {

		const a = idOf( faces[ i ].v1 );
		const b = idOf( faces[ i ].v2 );
		const c = idOf( faces[ i ].v3 );

		if ( a !== b && b !== c && a !== c ) {

			for ( const [ x, y ] of [ [ a, b ], [ b, c ], [ c, a ] ] ) {

				const key = x < y ? x + '-' + y : y + '-' + x;
				const entry = uses.get( key );
				if ( entry ) entry.n ++; else uses.set( key, { n: 1, a: x, b: y } );

			}

		}

		if ( i % SLICE_ITEMS === SLICE_ITEMS - 1 ) yield; // SLICED

	}

	const border = new Set();

	for ( const { n, a, b } of uses.values() ) {

		if ( n === 1 ) {

			border.add( a );
			border.add( b );

		}

	}

	for ( let i = 0; i < vertices.length; i ++ ) {

		if ( border.has( idOf( vertices[ i ] ) ) ) {

			vertices[ i ].border = true;
			vertices[ i ].slideTolerance = tolerance;
			vertices[ i ].covers = new Map();

		}

		if ( i % SLICE_ITEMS === SLICE_ITEMS - 1 ) yield; // SLICED

	}

}

// #4302: the neighbours of v along an open edge (an edge of exactly one of v's triangles).
function borderNeighbors( v ) {

	const out = [];

	for ( let i = 0; i < v.neighbors.length; i ++ ) {

		const n = v.neighbors[ i ];
		let shared = 0;

		for ( let j = 0; j < v.faces.length; j ++ ) if ( v.faces[ j ].hasVertex( n ) ) shared ++;

		if ( shared === 1 ) out.push( n );

	}

	return out;

}

const _slideSegment = new Vector3(), _slideToPoint = new Vector3(), _slideClosest = new Vector3();

// Distance from p to the segment a-b.
function distanceToSegment( p, a, b ) {

	_slideSegment.subVectors( b, a );
	_slideToPoint.subVectors( p, a );
	const lengthSq = _slideSegment.lengthSq();
	const t = lengthSq > 0 ? Math.min( 1, Math.max( 0, _slideToPoint.dot( _slideSegment ) / lengthSq ) ) : 0;
	_slideClosest.copy( a ).addScaledVector( _slideSegment, t );
	return p.distanceTo( _slideClosest );

}

// #4302: the original border points that lie between two vertices of a border, in the order they were
// absorbed: every vertex that was collapsed into the stretch from a to b. Empty when nothing was.
function coverBetween( a, b ) {

	return ( a.covers && a.covers.get( b ) ) || [];

}

function setCoverBetween( a, b, points ) {

	if ( ! a.covers ) a.covers = new Map();
	if ( ! b.covers ) b.covers = new Map();
	a.covers.set( b, points );
	b.covers.set( a, points );

}

// #4302: the cheapest way for a sliding border vertex to move: onto a neighbour on its own border, while every
// original border point it (and the vertices already collapsed into its two stretches) stood for stays within
// the tolerance of the stretch that replaces them. The distance is measured against the points the border
// started with, not against where its neighbours are now, so a gently curved border cannot be shortened one
// vertex at a time into a different shape; and a closed border (a hole) cannot shrink below three vertices,
// nor further than the tolerance allows. Nothing else may move it.
function computeSlidingBorderCost( v ) {

	const along = borderNeighbors( v );
	let bestCost = Infinity;
	let bestNeighbor = null;

	// Only a simple chain (exactly two border neighbours) can slide; a corner where borders meet stays.
	if ( along.length === 2 ) {

		for ( let i = 0; i < 2; i ++ ) {

			const target = along[ i ];
			const other = along[ 1 - i ];

			if ( ! target.border || ! other.border ) continue;

			// Collapsing would leave target and other joined twice (a loop of three that is already
			// closed): never.
			if ( borderNeighbors( other ).indexOf( target ) !== - 1 ) continue;

			let deviation = distanceToSegment( v.position, other.position, target.position );

			if ( deviation > v.slideTolerance ) continue;

			let within = true;

			for ( const stretch of [ coverBetween( v, other ), coverBetween( v, target ) ] ) {

				for ( let k = 0; k < stretch.length && within; k ++ ) {

					const d = distanceToSegment( stretch[ k ], other.position, target.position );
					if ( d > deviation ) deviation = d;
					if ( d > v.slideTolerance ) within = false;

				}

			}

			if ( ! within ) continue;

			const cost = deviation + 1e-3 * v.position.distanceTo( target.position );

			if ( cost < bestCost ) {

				bestCost = cost;
				bestNeighbor = target;

			}

		}

	}

	v.collapseNeighbor = bestNeighbor || v.neighbors[ 0 ];
	v.collapseCost = bestCost;

}

// #4302: called as a border vertex u collapses onto its border neighbour v: the border now runs from u's other
// border neighbour straight to v, and it stands for everything u and its two stretches stood for.
function absorbIntoBorder( u, v ) {

	const along = borderNeighbors( u );

	if ( along.length !== 2 || along.indexOf( v ) === - 1 ) return;

	const w = along[ 0 ] === v ? along[ 1 ] : along[ 0 ];
	const points = coverBetween( u, w ).concat( coverBetween( u, v ), [ u.position.clone() ] );
	setCoverBetween( w, v, points );

	// u is going away: forget it in its neighbours' maps, or each keeps the whole cover it ever held.
	if ( w.covers ) w.covers.delete( u );
	if ( v.covers ) v.covers.delete( u );
	u.covers = null;

}

function computeEdgeCostAtVertex( v ) {

	if ( v.neighbors.length === 0 ) {

		v.collapseNeighbor = null;
		v.collapseCost = - 0.01;

		return;

	}

	if ( v.locked ) {

		v.collapseNeighbor = v.neighbors[ 0 ];
		v.collapseCost = Infinity;

		return;

	}

	// #4302
	if ( v.border ) {

		computeSlidingBorderCost( v );
		return;

	}

	v.collapseCost = 100000;
	v.collapseNeighbor = null;

	for ( let i = 0; i < v.neighbors.length; i ++ ) {

		const collapseCost = computeEdgeCollapseCost( v, v.neighbors[ i ] );

		if ( ! v.collapseNeighbor ) {

			v.collapseNeighbor = v.neighbors[ i ];
			v.collapseCost = collapseCost;
			v.minCost = collapseCost;
			v.totalCost = 0;
			v.costCount = 0;

		}

		v.costCount ++;
		v.totalCost += collapseCost;

		if ( collapseCost < v.minCost ) {

			v.collapseNeighbor = v.neighbors[ i ];
			v.minCost = collapseCost;

		}

	}

	v.collapseCost = v.totalCost / v.costCount;

}

function removeVertex( v, vertices ) {

	console.assert( v.faces.length === 0 );

	while ( v.neighbors.length ) {

		const n = v.neighbors.pop();
		removeFromArray( n.neighbors, v );

	}

	removeFromArray( vertices, v );

}

function removeFace( f, faces ) {

	removeFromArray( faces, f );

	if ( f.v1 ) removeFromArray( f.v1.faces, f );
	if ( f.v2 ) removeFromArray( f.v2.faces, f );
	if ( f.v3 ) removeFromArray( f.v3.faces, f );

	const vs = [ f.v1, f.v2, f.v3 ];

	for ( let i = 0; i < 3; i ++ ) {

		const v1 = vs[ i ];
		const v2 = vs[ ( i + 1 ) % 3 ];

		if ( ! v1 || ! v2 ) continue;

		v1.removeIfNonNeighbor( v2 );
		v2.removeIfNonNeighbor( v1 );

	}

}

function collapse( vertices, faces, u, v ) {

	if ( ! v ) {

		removeVertex( u, vertices );
		return;

	}

	// #4302
	if ( u.border && v.border ) absorbIntoBorder( u, v );

	if ( v.uv ) {

		u.uv.copy( v.uv );

	}

	// EXTRA UV start
	for ( let i = 0; i < EXTRA_UV_NAMES.length; i ++ ) {

		if ( v.extraUv[ i ] ) u.extraUv[ i ].copy( v.extraUv[ i ] );

	}
	// EXTRA UV end

	if ( v.normal ) {

		v.normal.add( u.normal ).normalize();

	}

	if ( v.tangent ) {

		v.tangent.add( u.tangent ).normalize();

	}

	const tmpVertices = [];

	for ( let i = 0; i < u.neighbors.length; i ++ ) {

		tmpVertices.push( u.neighbors[ i ] );

	}

	for ( let i = u.faces.length - 1; i >= 0; i -- ) {

		if ( u.faces[ i ] && u.faces[ i ].hasVertex( v ) ) {

			removeFace( u.faces[ i ], faces );

		}

	}

	for ( let i = u.faces.length - 1; i >= 0; i -- ) {

		u.faces[ i ].replaceVertex( u, v );

	}

	removeVertex( u, vertices );

	for ( let i = 0; i < tmpVertices.length; i ++ ) {

		computeEdgeCostAtVertex( tmpVertices[ i ] );

	}

}

function minimumCostEdge( vertices ) {

	let least = vertices[ 0 ];

	for ( let i = 0; i < vertices.length; i ++ ) {

		if ( vertices[ i ].collapseCost < least.collapseCost ) {

			least = vertices[ i ];

		}

	}

	return least;

}

class Triangle {

	constructor( v1, v2, v3, a, b, c ) {

		this.a = a;
		this.b = b;
		this.c = c;

		this.v1 = v1;
		this.v2 = v2;
		this.v3 = v3;

		this.normal = new Vector3();

		this.computeNormal();

		v1.faces.push( this );
		v1.addUniqueNeighbor( v2 );
		v1.addUniqueNeighbor( v3 );

		v2.faces.push( this );
		v2.addUniqueNeighbor( v1 );
		v2.addUniqueNeighbor( v3 );

		v3.faces.push( this );
		v3.addUniqueNeighbor( v1 );
		v3.addUniqueNeighbor( v2 );

	}

	computeNormal() {

		const vA = this.v1.position;
		const vB = this.v2.position;
		const vC = this.v3.position;

		_cb.subVectors( vC, vB );
		_ab.subVectors( vA, vB );
		_cb.cross( _ab ).normalize();

		this.normal.copy( _cb );

	}

	hasVertex( v ) {

		return v === this.v1 || v === this.v2 || v === this.v3;

	}

	replaceVertex( oldv, newv ) {

		if ( oldv === this.v1 ) this.v1 = newv;
		else if ( oldv === this.v2 ) this.v2 = newv;
		else if ( oldv === this.v3 ) this.v3 = newv;

		removeFromArray( oldv.faces, this );
		newv.faces.push( this );

		oldv.removeIfNonNeighbor( this.v1 );
		this.v1.removeIfNonNeighbor( oldv );

		oldv.removeIfNonNeighbor( this.v2 );
		this.v2.removeIfNonNeighbor( oldv );

		oldv.removeIfNonNeighbor( this.v3 );
		this.v3.removeIfNonNeighbor( oldv );

		this.v1.addUniqueNeighbor( this.v2 );
		this.v1.addUniqueNeighbor( this.v3 );

		this.v2.addUniqueNeighbor( this.v1 );
		this.v2.addUniqueNeighbor( this.v3 );

		this.v3.addUniqueNeighbor( this.v1 );
		this.v3.addUniqueNeighbor( this.v2 );

		this.computeNormal();

	}

}

class Vertex {

	constructor( v, uv, normal, tangent, color, extraUv ) { // EXTRA UV

		this.position = v;
		this.uv = uv;
		this.normal = normal;
		this.tangent = tangent;
		this.color = color;
		this.extraUv = extraUv || []; // EXTRA UV

		this.id = - 1;

		this.faces = [];
		this.neighbors = [];

		this.collapseCost = 0;
		this.collapseNeighbor = null;
		this.locked = false; // #3528: shares its position with another vertex
		this.border = false; // #4302: on an open edge and allowed to slide along it (options.slideBorders)
		this.slideTolerance = 0;
		this.covers = null; // #4302: original border points absorbed into each of its border stretches

	}

	addUniqueNeighbor( vertex ) {

		pushIfUnique( this.neighbors, vertex );

	}

	removeIfNonNeighbor( n ) {

		const neighbors = this.neighbors;
		const faces = this.faces;

		const offset = neighbors.indexOf( n );

		if ( offset === - 1 ) return;

		for ( let i = 0; i < faces.length; i ++ ) {

			if ( faces[ i ].hasVertex( n ) ) return;

		}

		neighbors.splice( offset, 1 );

	}

}

export { SimplifyModifier };
