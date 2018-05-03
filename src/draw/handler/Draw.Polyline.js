/**
 * @class L.Draw.Polyline
 * @aka Draw.Polyline
 * @inherits L.Draw.Feature
 */
L.Draw.Polyline = L.Draw.Feature.extend({
	statics: {
		TYPE: 'polyline'
	},

	Poly: L.Polyline,

	options: {
		allowIntersection: true,
		repeatMode: false,
		drawError: {
			color: '#b00b00',
			timeout: 2500
		},
		icon: new L.DivIcon({
			iconSize: new L.Point(8, 8),
			className: 'leaflet-div-icon leaflet-editing-icon'
		}),
		touchIcon: new L.DivIcon({
			iconSize: new L.Point(10, 10),
			className: 'leaflet-div-icon leaflet-editing-icon leaflet-touch-icon'
		}),
		guidelineDistance: 20,
		maxGuideLineLength: 4000,
		shapeOptions: {
			stroke: true,
			color: '#3388ff',
			weight: 4,
			opacity: 0.5,
			fill: false,
			clickable: true
		},
		metric: false, // Whether to use the metric measurement system or imperial
		feet: false, // When not metric, to use feet instead of yards for display.
		nautic: false, // When not metric, not feet use nautic mile for display
		showLength: false, // Whether to display distance in the tooltip
		zIndexOffset: 2000, // This should be > than the highest z-index any map layers
		factor: 1, // To change distance calculation
		maxPoints: 0, // Once this number of points are placed, finish shape
		snappable: false,
		snapDistance: 20,
	},

	// @method initialize(): void
	initialize: function (map, options) {
		// if touch, switch to touch icon
		if (L.Browser.touch) {
			this.options.icon = this.options.touchIcon;
		}

		// Need to set this here to ensure the correct message is used.
		this.options.drawError.message = L.drawLocal.draw.handlers.polyline.error;

		// Merge default drawError options with custom options
		if (options && options.drawError) {
			options.drawError = L.Util.extend({}, this.options.drawError, options.drawError);
		}

		// Save the type so super can fire, need to do this as cannot do this.TYPE :(
		this.type = L.Draw.Polyline.TYPE;

		L.Draw.Feature.prototype.initialize.call(this, map, options);

	},

	// @method addHooks(): void
	// Add listener hooks to this handler
	addHooks: function () {
		L.Draw.Feature.prototype.addHooks.call(this);
		if (this._map) {
			this._markers = [];

			this._cacheIndex = 0;
			this._cacheMarkers = []; //缓存绘制的点，用于撤销恢复

			this._markerGroup = new L.LayerGroup();
			this._map.addLayer(this._markerGroup);

			this._poly = new L.Polyline([], this.options.shapeOptions);

			this._tooltip.updateContent(this._getTooltipText());

			// Make a transparent marker that will used to catch click events. These click
			// events will create the vertices. We need to do this so we can ensure that
			// we can create vertices over other map layers (markers, vector layers). We
			// also do not want to trigger any click handlers of objects we are clicking on
			// while drawing.
			if (!this._mouseMarker) {
				this._mouseMarker = L.marker(this._map.getCenter(), {
					icon: L.divIcon({
						className: 'leaflet-mouse-marker',
						iconAnchor: [20, 20],
						iconSize: [40, 40]
					}),
					opacity: 0,
					zIndexOffset: this.options.zIndexOffset
				});
			}
			this._hintline = L.polyline([]).addTo(this._map);;

			this._mouseMarker
				.on('mouseout', this._onMouseOut, this)
				.on('mousemove', this._onMouseMove, this) // Necessary to prevent 0.8 stutter
				.on('mousedown', this._onMouseDown, this)
				.on('mouseup', this._onMouseUp, this) // Necessary for 0.8 compatibility
				.on("move", this._syncHintLine, this)
				.addTo(this._map);

			this._map
				.on('mouseup', this._onMouseUp, this) // Necessary for 0.7 compatibility
				.on('mousemove', this._onMouseMove, this)
				.on('zoomlevelschange', this._onZoomEnd, this)
				.on('touchstart', this._onTouch, this)
				.on('zoomend', this._onZoomEnd, this)
				.on('keypress', this._onKeyPress, this);
		}
	},

	// @method removeHooks(): void
	// Remove listener hooks from this handler.
	removeHooks: function () {
		L.Draw.Feature.prototype.removeHooks.call(this);

		this._clearHideErrorTimeout();

		this._cleanUpShape();

		// remove markers from map
		this._map.removeLayer(this._markerGroup);
		delete this._markerGroup;
		delete this._markers;
		this._markers = [];
		this._cacheMarkers = [];

		this._map.removeLayer(this._poly);
		delete this._poly;

		this._mouseMarker
			.off('mousedown', this._onMouseDown, this)
			.off('mouseout', this._onMouseOut, this)
			.off('mouseup', this._onMouseUp, this)
			.off('mousemove', this._onMouseMove, this);
		this._map.removeLayer(this._mouseMarker);
		delete this._mouseMarker;

		// clean up DOM
		this._clearGuides();

		this._map
			.off('mouseup', this._onMouseUp, this)
			.off('mousemove', this._onMouseMove, this)
			.off('zoomlevelschange', this._onZoomEnd, this)
			.off('zoomend', this._onZoomEnd, this)
			.off('touchstart', this._onTouch, this)
			.off('click', this._onTouch, this)
			.off('keypress', this._onKeyPress, this);
	},

	// @method deleteLastVertex(): void
	// Remove the last vertex from the polyline, removes polyline from map if only one point exists.
	deleteLastVertex: function () {
		if (this._markers.length <= 1) {
			return;
		}

		var lastMarker = this._markers.pop(),
			poly = this._poly,
			// Replaces .spliceLatLngs()
			latlngs = poly.getLatLngs(),
			latlng = latlngs.splice(-1, 1)[0];
		this._poly.setLatLngs(latlngs);

		this._markerGroup.removeLayer(lastMarker);

		if (poly.getLatLngs().length < 2) {
			this._map.removeLayer(poly);
		}

		this._vertexChanged(latlng, false);
	},

	// @method addVertex(): void
	// Add a vertex to the end of the polyline
	addVertex: function (position, cache) {
		if (!this._mouseMarker._snapped) {
			this._mouseMarker.setLatLng(position);
		}
		var latlng = this._mouseMarker.getLatLng();
		var markersLength = this._markers.length;
		// markersLength must be greater than or equal to 2 before intersections can occur
		if (markersLength >= 2 && !this.options.allowIntersection && this._poly.newLatLngIntersects(latlng)) {
			this._showErrorTooltip();
			return;
		}
		else if (this._errorShown) {
			this._hideErrorTooltip();
		}

		this._markers.push(this._createMarker(latlng));

		this._poly.addLatLng(latlng);

		if (this._poly.getLatLngs().length === 2) {
			this._map.addLayer(this._poly);
		}

		this._vertexChanged(latlng, true);
	},

	// @method completeShape(): void
	// Closes the polyline between the first and last points
	completeShape: function () {
		if (this._markers.length <= 1) {
			return;
		}

		this._fireCreatedEvent();
		this.disable();

		if (this.options.repeatMode) {
			this.enable();
		}
	},

	_finishShape: function () {
		var latlngs = this._poly._defaultShape ? this._poly._defaultShape() : this._poly.getLatLngs();
		var intersects = this._poly.newLatLngIntersects(latlngs[latlngs.length - 1]);

		if ((!this.options.allowIntersection && intersects) || !this._shapeIsValid()) {
			this._showErrorTooltip();
			return;
		}

		this._fireCreatedEvent();
		this.disable();
		if (this.options.repeatMode) {
			this.enable();
		}
	},

	// Called to verify the shape is valid when the user tries to finish it
	// Return false if the shape is not valid
	_shapeIsValid: function () {
		return true;
	},

	_onZoomEnd: function () {
		if (this._markers !== null) {
			this._updateGuide();
		}
	},

	_onMouseMove: function (e) {
		var newPos;
		var latlng;

		if (this.options.snappable ) {
			this._syncHintMarker(e);
					
			if(this._mouseMarker._snapped) {
				latlng = this._mouseMarker.getLatLng();
				newPos = this._map.latLngToLayerPoint(latlng);
			}
			else {
				newPos = this._map.mouseEventToLayerPoint(e.originalEvent);
				latlng = this._map.layerPointToLatLng(newPos);
				// Update the mouse marker position
				this._mouseMarker.setLatLng(latlng);
			}
		}
		else {
			newPos = this._map.mouseEventToLayerPoint(e.originalEvent);
			latlng = this._map.layerPointToLatLng(newPos);
			// Update the mouse marker position
			this._mouseMarker.setLatLng(latlng);
		}
		// Save latlng
		// should this be moved to _updateGuide() ?
		this._currentLatLng = latlng;

		this._updateTooltip(latlng);

		// Update the guide line
		this._updateGuide(newPos);

		L.DomEvent.preventDefault(e.originalEvent);
	},
	_syncHintLine: function () {
		var polyPoints = this._hintline.getLatLngs();

		if (polyPoints.length > 0) {
			var lastPolygonPoint = polyPoints[polyPoints.length - 1];

			// set coords for hintline from marker to last vertex of drawin polyline
			this._hintline.setLatLngs([lastPolygonPoint, this._mouseMarker.getLatLng()]);
		}
	},

	//捕捉
	_syncHintMarker: function (e) {
		// move the cursor marker
		// this._hintMarker.setLatLng(e.latlng);

		// if snapping is enabled, do it
		this._mouseMarker._snapped = false;
		var fakeDragEvent = e;
		fakeDragEvent.target = this._mouseMarker;
		this._handleSnapping(fakeDragEvent);

		// if self-intersection is forbidden, handle it
		if (!this.options.allowSelfIntersection) {
			this._handleSelfIntersection();
		}
	},

	_handleSelfIntersection: function () {
		// ok we need to check the self intersection here
		// problem: during draw, the marker on the cursor is not yet part
		// of the layer. So we need to clone the layer, add the
		// potential new vertex (cursor markers latlngs) and check the self
		// intersection on the clone. Phew... - let's do it 💪

		// clone layer (polyline is enough, even when it's a polygon)
		var clone = L.polyline(this._poly.getLatLngs());

		// add the vertex
		clone.addLatLng(this._mouseMarker.getLatLng());

		// check the self intersection
		// const selfIntersection = kinks(clone.toGeoJSON());
		// this._doesSelfIntersect = selfIntersection.features.length > 0;

		// change the style based on self intersection
		/* if (this._doesSelfIntersect) {
				this._hintline.setStyle({
						color: 'red',
				});
		} else {
				this._hintline.setStyle(this.options.hintlineStyle);
		} */
	},

	_vertexChanged: function (latlng, added) {
		this._map.fire(L.Draw.Event.DRAWVERTEX, { layers: this._markerGroup });
		this._updateFinishHandler();

		this._updateRunningMeasure(latlng, added);

		this._clearGuides();

		this._updateTooltip();
	},

	_onMouseDown: function (e) {
		if (!this._clickHandled && !this._touchHandled && !this._disableMarkers) {
			this._onMouseMove(e);
			this._clickHandled = true;
			this._disableNewMarkers();
			var originalEvent = e.originalEvent;
			var clientX = originalEvent.clientX;
			var clientY = originalEvent.clientY;
			this._startPoint.call(this, clientX, clientY);
		}
	},

	_startPoint: function (clientX, clientY) {
		this._mouseDownOrigin = L.point(clientX, clientY);
	},

	_onMouseUp: function (e) {
		var originalEvent = e.originalEvent;
		var clientX = originalEvent.clientX;
		var clientY = originalEvent.clientY;
		this._endPoint.call(this, clientX, clientY, e);
		this._clickHandled = null;
	},

	_endPoint: function (clientX, clientY, e) {
		if (this._mouseDownOrigin) {
			var dragCheckDistance = L.point(clientX, clientY)
				.distanceTo(this._mouseDownOrigin);
			var lastPtDistance = this._calculateFinishDistance(e.latlng);
			if (this.options.maxPoints > 1 && this.options.maxPoints == this._markers.length + 1) {
				this.addVertex(e.latlng);

				for (var k = 0, len = this._markers.length; k < len; k++) {
					this._cacheMarkers.push(this._markers[k].getLatLng());
				}
				this._cacheIndex = this._cacheMarkers.length - 1;

				this._finishShape();
			} else if (lastPtDistance < 10 && L.Browser.touch) {
				this._finishShape();
			} else if (Math.abs(dragCheckDistance) < 9 * (window.devicePixelRatio || 1)) {
				this.addVertex(e.latlng);

				for (var k = 0, len = this._markers.length; k < len; k++) {
					this._cacheMarkers.push(this._markers[k].getLatLng());
				}

				this._cacheIndex = this._cacheMarkers.length - 1;
			}
			this._enableNewMarkers(); // after a short pause, enable new markers
		}
		this._mouseDownOrigin = null;
	},

	// ontouch prevented by clickHandled flag because some browsers fire both click/touch events,
	// causing unwanted behavior
	_onTouch: function (e) {
		var originalEvent = e.originalEvent;
		var clientX;
		var clientY;
		if (originalEvent.touches && originalEvent.touches[0] && !this._clickHandled && !this._touchHandled && !this._disableMarkers) {
			clientX = originalEvent.touches[0].clientX;
			clientY = originalEvent.touches[0].clientY;
			this._disableNewMarkers();
			this._touchHandled = true;
			this._startPoint.call(this, clientX, clientY);
			this._endPoint.call(this, clientX, clientY, e);
			this._touchHandled = null;
		}
		this._clickHandled = null;
	},

	_onMouseOut: function () {
		if (this._tooltip) {
			this._tooltip._onMouseOut.call(this._tooltip);
		}
	},

	// calculate if we are currently within close enough distance
	// of the closing point (first point for shapes, last point for lines)
	// this is semi-ugly code but the only reliable way i found to get the job done
	// note: calculating point.distanceTo between mouseDownOrigin and last marker did NOT work
	_calculateFinishDistance: function (potentialLatLng) {
		var lastPtDistance;
		if (this._markers.length > 0) {
			var finishMarker;
			if (this.type === L.Draw.Polyline.TYPE) {
				finishMarker = this._markers[this._markers.length - 1];
			} else if (this.type === L.Draw.Polygon.TYPE) {
				finishMarker = this._markers[0];
			} else {
				return Infinity;
			}
			var lastMarkerPoint = this._map.latLngToContainerPoint(finishMarker.getLatLng()),
				potentialMarker = new L.Marker(potentialLatLng, {
					icon: this.options.icon,
					zIndexOffset: this.options.zIndexOffset * 2
				});
			var potentialMarkerPint = this._map.latLngToContainerPoint(potentialMarker.getLatLng());
			lastPtDistance = lastMarkerPoint.distanceTo(potentialMarkerPint);
		} else {
			lastPtDistance = Infinity;
		}
		return lastPtDistance;
	},

	_updateFinishHandler: function () {
		var markerCount = this._markers.length;
		// The last marker should have a click handler to close the polyline
		if (markerCount > 1) {
			this._markers[markerCount - 1].on('click', this._finishShape, this);
		}

		// Remove the old marker click handler (as only the last point should close the polyline)
		if (markerCount > 2) {
			this._markers[markerCount - 2].off('click', this._finishShape, this);
		}
	},

	_createMarker: function (latlng) {
		var marker = new L.Marker(latlng, {
			icon: this.options.icon,
			zIndexOffset: this.options.zIndexOffset * 2
		});

		this._markerGroup.addLayer(marker);

		return marker;
	},

	_updateGuide: function (newPos) {
		var markerCount = this._markers ? this._markers.length : 0;

		if (markerCount > 0) {
			newPos = newPos || this._map.latLngToLayerPoint(this._currentLatLng);

			// draw the guide line
			this._clearGuides();
			this._drawGuide(
				this._map.latLngToLayerPoint(this._markers[markerCount - 1].getLatLng()),
				newPos
			);
		}
	},

	_updateTooltip: function (latLng) {
		var text = this._getTooltipText();

		if (latLng) {
			this._tooltip.updatePosition(latLng);
		}

		if (!this._errorShown) {
			this._tooltip.updateContent(text);
		}
	},

	_drawGuide: function (pointA, pointB) {
		var length = Math.floor(Math.sqrt(Math.pow((pointB.x - pointA.x), 2) + Math.pow((pointB.y - pointA.y), 2))),
			guidelineDistance = this.options.guidelineDistance,
			maxGuideLineLength = this.options.maxGuideLineLength,
			// Only draw a guideline with a max length
			i = length > maxGuideLineLength ? length - maxGuideLineLength : guidelineDistance,
			fraction,
			dashPoint,
			dash;

		//create the guides container if we haven't yet
		if (!this._guidesContainer) {
			this._guidesContainer = L.DomUtil.create('div', 'leaflet-draw-guides', this._overlayPane);
		}

		//draw a dash every GuildeLineDistance
		for (; i < length; i += this.options.guidelineDistance) {
			//work out fraction along line we are
			fraction = i / length;

			//calculate new x,y point
			dashPoint = {
				x: Math.floor((pointA.x * (1 - fraction)) + (fraction * pointB.x)),
				y: Math.floor((pointA.y * (1 - fraction)) + (fraction * pointB.y))
			};

			//add guide dash to guide container
			dash = L.DomUtil.create('div', 'leaflet-draw-guide-dash', this._guidesContainer);
			dash.style.backgroundColor =
				!this._errorShown ? this.options.shapeOptions.color : this.options.drawError.color;

			L.DomUtil.setPosition(dash, dashPoint);
		}
	},

	_updateGuideColor: function (color) {
		if (this._guidesContainer) {
			for (var i = 0, l = this._guidesContainer.childNodes.length; i < l; i++) {
				this._guidesContainer.childNodes[i].style.backgroundColor = color;
			}
		}
	},

	// removes all child elements (guide dashes) from the guides container
	_clearGuides: function () {
		if (this._guidesContainer) {
			while (this._guidesContainer.firstChild) {
				this._guidesContainer.removeChild(this._guidesContainer.firstChild);
			}
		}
	},

	_getTooltipText: function () {
		var showLength = this.options.showLength,
			labelText, distanceStr;
		if (this._markers.length === 0) {
			labelText = {
				text: L.drawLocal.draw.handlers.polyline.tooltip.start
			};
		} else {
			distanceStr = showLength ? this._getMeasurementString() : '';

			if (this._markers.length === 1) {
				labelText = {
					text: L.drawLocal.draw.handlers.polyline.tooltip.cont,
					subtext: distanceStr
				};
			} else {
				labelText = {
					text: L.drawLocal.draw.handlers.polyline.tooltip.end,
					subtext: distanceStr
				};
			}
		}
		return labelText;
	},

	_updateRunningMeasure: function (latlng, added) {
		var markersLength = this._markers.length,
			previousMarkerIndex, distance;

		if (this._markers.length === 1) {
			this._measurementRunningTotal = 0;
		} else {
			previousMarkerIndex = markersLength - (added ? 2 : 1);

			// Calculate the distance based on the version
			if (L.GeometryUtil.isVersion07x()) {
				distance = latlng.distanceTo(this._markers[previousMarkerIndex].getLatLng()) * (this.options.factor || 1);
			} else {
				distance = this._map.distance(latlng, this._markers[previousMarkerIndex].getLatLng()) * (this.options.factor || 1);
			}

			this._measurementRunningTotal += distance * (added ? 1 : -1);
		}
	},

	_getMeasurementString: function () {
		var currentLatLng = this._currentLatLng,
			previousLatLng = this._markers[this._markers.length - 1].getLatLng(),
			distance;

		// Calculate the distance from the last fixed point to the mouse position based on the version
		if (L.GeometryUtil.isVersion07x()) {
			distance = previousLatLng && currentLatLng && currentLatLng.distanceTo ? this._measurementRunningTotal + currentLatLng.distanceTo(previousLatLng) * (this.options.factor || 1) : this._measurementRunningTotal || 0;
		} else {
			distance = previousLatLng && currentLatLng ? this._measurementRunningTotal + this._map.distance(currentLatLng, previousLatLng) * (this.options.factor || 1) : this._measurementRunningTotal || 0;
		}

		return L.GeometryUtil.readableDistance(distance, this.options.metric, this.options.feet, this.options.nautic, this.options.precision);
	},

	_showErrorTooltip: function () {
		this._errorShown = true;

		// Update tooltip
		this._tooltip
			.showAsError()
			.updateContent({ text: this.options.drawError.message });

		// Update shape
		this._updateGuideColor(this.options.drawError.color);
		this._poly.setStyle({ color: this.options.drawError.color });

		// Hide the error after 2 seconds
		this._clearHideErrorTimeout();
		this._hideErrorTimeout = setTimeout(L.Util.bind(this._hideErrorTooltip, this), this.options.drawError.timeout);
	},

	_hideErrorTooltip: function () {
		this._errorShown = false;

		this._clearHideErrorTimeout();

		// Revert tooltip
		this._tooltip
			.removeError()
			.updateContent(this._getTooltipText());

		// Revert shape
		this._updateGuideColor(this.options.shapeOptions.color);
		this._poly.setStyle({ color: this.options.shapeOptions.color });
	},

	_clearHideErrorTimeout: function () {
		if (this._hideErrorTimeout) {
			clearTimeout(this._hideErrorTimeout);
			this._hideErrorTimeout = null;
		}
	},

	// disable new markers temporarily;
	// this is to prevent duplicated touch/click events in some browsers
	_disableNewMarkers: function () {
		this._disableMarkers = true;
	},

	// see _disableNewMarkers
	_enableNewMarkers: function () {
		setTimeout(function () {
			this._disableMarkers = false;
		}.bind(this), 50);
	},

	_cleanUpShape: function () {
		if (this._markers.length > 1) {
			this._markers[this._markers.length - 1].off('click', this._finishShape, this);
		}
	},

	_fireCreatedEvent: function () {
		var poly = new this.Poly(this._poly.getLatLngs(), this.options.shapeOptions);
		L.Draw.Feature.prototype._fireCreatedEvent.call(this, poly);
	},

	//键盘z、y撤销恢复
	_onKeyPress: function (e) {
		var eCode = e.originalEvent.charCode;
		if (eCode == 122) {
			//按住z键撤销
			this._undo();
		}
		else if (eCode == 121) {
			//按住y键恢复
			this._redo();
		}
	},

	//撤销
	_undo: function () {
		if (this._markers.length <= 1) {
			return;
		}
		this.deleteLastVertex();
		this._cacheIndex--;
	},

	//恢复
	_redo: function () {
		this._cacheIndex++;
		if (this._cacheIndex >= this._cacheMarkers.length) {
			return;
		}
		var lnglat = this._cacheMarkers[this._cacheIndex];
		this.addVertex(lnglat, false);
	},


	_initSnappableMarkers: function () {
		this.options.snapDistance = this.options.snapDistance || 30;

		if (this.isPolygon()) {
			// coords is a multidimansional array, handle all rings
			this._markers.map(this._assignEvents, this);
		} else {
			// coords is one dimensional, handle the ring
			this._assignEvents(this._markers);
		}

		this._layer.off('pm:dragstart', this._unsnap, this);
		this._layer.on('pm:dragstart', this._unsnap, this);
	},
	_assignEvents: function (markerArr) {
		// loop through marker array and assign events to the markers
		/* markerArr.forEach(function(marker) {
			marker.off('drag', this._handleSnapping, this);
			marker.on('drag', this._handleSnapping, this);

			marker.off('dragend', this._cleanupSnapping, this);
			marker.on('dragend', this._cleanupSnapping, this);
		}); */
	},
	_unsnap: function () {
		// delete the last snap
		delete this._snapLatLng;
	},
	_cleanupSnapping: function () {
		// delete it, we need to refresh this with each start of a drag because
		// meanwhile, new layers could've been added to the map
		delete this._snapList;

		// remove map event
		this._map.off('pm:remove', this._handleSnapLayerRemoval, this);

		if (this.debugIndicatorLines) {
			/* this.debugIndicatorLines.forEach(function(line) {
				line.remove();
			}); */
		}
	},
	_handleSnapLayerRemoval: function (evt) {
		// find the layers index in snaplist
		var index = this._snapList.findIndex(function (e) { e._leaflet_id === evt.layer._leaflet_id });
		// remove it from the snaplist
		this._snapList.splice(index, 1);
	},
	_handleSnapping: function (e) {
		var marker = e.target;
		marker._snapped = false;
		// if snapping is disabled via holding ALT during drag, stop right here
		if (e.originalEvent.altKey) {
			return false;
		}

		// create a list of polygons that the marker could snap to
		// this isn't inside a movestart/dragstart callback because middlemarkers are initialized
		// after dragstart/movestart so it wouldn't fire for them
		/* if (this._snapList === undefined) {
			this._createSnapList(e);
		} */

		this._snapList = this.options.snapFeatureGroup.getLayers();
		// if there are no layers to snap to, stop here

		if (this._snapList.length <= 0) {
			return false;
		}


		// get the closest layer, it's closest latlng, segment and the distance
		// var closestLayer = this._calcClosestLayer(marker.getLatLng(), this._snapList);

		// var closestLayer = this._calcClosestLayer(marker.getLatLng(), this._snapList);
		var closestLayer = this._calcClosestLayer(e.latlng, this._snapList);
		

		var isMarker = closestLayer.layer instanceof L.Marker || closestLayer.layer instanceof L.CircleMarker;

		// find the final latlng that we want to snap to
		var snapLatLng;
		if (!isMarker) {
			snapLatLng = this._checkPrioritiySnapping(closestLayer);
		} else {
			snapLatLng = closestLayer.latlng;
		}

		// minimal distance before marker snaps (in pixels)
		var minDistance = this.options.snapDistance;

		// event info for pm:snap and pm:unsnap
		var eventInfo = {
			marker: marker,
			snapLatLng: snapLatLng,
			segment: closestLayer.segment,
			layer: this._layer,
			layerInteractedWith: closestLayer.layer, // for lack of a better property name
		};

		if (closestLayer.distance < minDistance) {
			// snap the marker
			marker.setLatLng(snapLatLng);

			marker._snapped = true;

			var triggerSnap = function () {
				this._snapLatLng = snapLatLng;
				// marker.fire('pm:snap', eventInfo);
				// this._layer.fire('pm:snap', eventInfo);
			};

			// check if the snapping position differs from the last snap
			// Thanks Max & car2go Team
			var a = this._snapLatLng || {};
			var b = snapLatLng || {};

			if (a.lat !== b.lat || a.lng !== b.lng) {
				triggerSnap();
			}
		} else if (this._snapLatLng) {
			marker._snapped = false;
			// no more snapping

			// if it was previously snapped...
			// ...unsnap
			this._unsnap(eventInfo);


			// and fire unsnap event
			// eventInfo.marker.fire('pm:unsnap', eventInfo);
			// this._layer.fire('pm:unsnap', eventInfo);
		}

		return true;
	},

	// we got the point we want to snap to (C), but we need to check if a coord of the polygon
	// receives priority over C as the snapping point. Let's check this here
	_checkPrioritiySnapping: function (closestLayer) {
		var map = this._map;

		// A and B are the points of the closest segment to P (the marker position we want to snap)
		var A = closestLayer.segment[0];
		var B = closestLayer.segment[1];

		// C is the point we would snap to on the segment.
		// The closest point on the closest segment of the closest polygon to P. That's right.
		var C = closestLayer.latlng;

		// distances from A to C and B to C to check which one is closer to C
		var distanceAC = this._getDistance(map, A, C);
		var distanceBC = this._getDistance(map, B, C);

		// closest latlng of A and B to C
		var closestVertexLatLng = distanceAC < distanceBC ? A : B;

		// distance between closestVertexLatLng and C
		var shortestDistance = distanceAC < distanceBC ? distanceAC : distanceBC;

		// the distance that needs to be undercut to trigger priority
		var priorityDistance = this.options.snapDistance;

		// the latlng we ultemately want to snap to
		var snapLatlng;

		// if C is closer to the closestVertexLatLng (A or B) than the snapDistance,
		// the closestVertexLatLng has priority over C as the snapping point.
		if (shortestDistance < priorityDistance) {
			snapLatlng = closestVertexLatLng;
		} else {
			snapLatlng = C;
		}

		// return the copy of snapping point
		return Object.assign({}, snapLatlng);
	},

	_createSnapList: function () {
		var layers = [];
		var debugIndicatorLines = [];
		var map = this._map;

		// find all layers that are or inherit from Polylines... and markers that are not
		// temporary markers of polygon-edits
		map.eachLayer(function (layer) {
			if (layer instanceof L.Polyline || layer instanceof L.Marker || layer instanceof L.CircleMarker) {
				layers.push(layer);

				map.off('pm:remove', this._handleSnapLayerRemoval, this);
				map.on('pm:remove', this._handleSnapLayerRemoval, this);

				// this is for debugging
				var debugLine = L.polyline([], { color: 'red', pmIgnore: true });
				debugIndicatorLines.push(debugLine);

				// uncomment 👇 this line to show helper lines for debugging
				// debugLine.addTo(map);
			}
		});

		// ...except myself
		layers = layers.filter(function (layer) { this._layer !== layer });

		// also remove everything that has no coordinates yet
		layers = layers.filter(function (layer) { layer._latlng || (layer._latlngs && layer._latlngs.length > 0) });

		// finally remove everything that's leaflet.pm specific temporary stuff
		layers = layers.filter(function (layer) { !layer._pmTempLayer });

		// save snaplist from layers and the other snap layers added from other classes/scripts
		if (this._otherSnapLayers) {
			this._snapList = layers.concat(this._otherSnapLayers);
		} else {
			this._snapList = layers;
		}

		this.debugIndicatorLines = debugIndicatorLines;
	},
	_calcClosestLayer: function (latlng, layers) {
		// the closest polygon to our dragged marker latlng
		var closestLayer = {};

		// loop through the layers
		for (var i = layers.length; i--;) {
			var layer = layers[i];
			var results = this._calcLayerDistances(latlng, layer);

			// show indicator lines, it's for debugging
			// this.debugIndicatorLines[i].setLatLngs([latlng, results.latlng]);

			// save the info if it doesn't exist or if the distance is smaller than the previous one
			if (closestLayer.distance === undefined || results.distance < closestLayer.distance) {
				closestLayer = results;
				closestLayer.layer = layer;
			}
		}
		// return the closest layer and it's data
		// if there is no closest layer, return undefined
		return closestLayer;
	},

	_calcLayerDistances: function (latlng, layer) {
		var map = this._map;

		// is this a polyline, marker or polygon?
		var isPolygon = layer instanceof L.Polygon;
		var isPolyline = !(layer instanceof L.Polygon) && layer instanceof L.Polyline;
		var isMarker = layer instanceof L.Marker || layer instanceof L.CircleMarker;

		// the point P which we want to snap (probpably the marker that is dragged)
		var P = latlng;

		var coords;

		// the coords of the layer
		if (isPolygon) {
			// polygon
			coords = layer.getLatLngs()[0];
		} else if (isPolyline) {
			// polyline
			coords = layer.getLatLngs();
		} else if (isMarker) {
			// marker
			coords = layer.getLatLng();

			// return the info for the marker, no more calculations needed
			return {
				latlng: Object.assign({}, coords),
				distance: this._getDistance(map, coords, P),
			};
		}

		// the closest segment (line between two points) of the layer
		var closestSegment;

		// the shortest distance from P to closestSegment
		var shortestDistance;

		// loop through the coords of the layer

		for (var index = 0, len = coords.length; index < len; index++) {
			var coord = coords[index];
			// take this coord (A)...
			var A = coord;
			var nextIndex;

			// and the next coord (B) as points
			if (isPolygon) {
				nextIndex = index + 1 === coords.length ? 0 : index + 1;
			} else {
				nextIndex = index + 1 === coords.length ? undefined : index + 1;
			}

			var B = coords[nextIndex];

			if (B) {
				// calc the distance between P and AB-segment
				var distance = this._getDistanceToSegment(map, P, A, B);

				// is the distance shorter than the previous one? Save it and the segment
				if (shortestDistance === undefined || distance < shortestDistance) {
					shortestDistance = distance;
					closestSegment = [A, B];
				}
			}
		}
		/* coords.forEach(function(coord, index) {
			// take this coord (A)...
			var A = coord;
			var nextIndex;

			// and the next coord (B) as points
			if (isPolygon) {
				nextIndex = index + 1 === coords.length ? 0 : index + 1;
			} else {
				nextIndex = index + 1 === coords.length ? undefined : index + 1;
			}

			var B = coords[nextIndex];

			if (B) {
				// calc the distance between P and AB-segment
				var distance = this._getDistanceToSegment(map, P, A, B);

				// is the distance shorter than the previous one? Save it and the segment
				if (shortestDistance === undefined || distance < shortestDistance) {
					shortestDistance = distance;
					closestSegment = [A, B];
				}
			}

			return true;
		}); */

		// now, take the closest segment (closestSegment) and calc the closest point to P on it.
		var C = this._getClosestPointOnSegment(map, latlng, closestSegment[0], closestSegment[1]);

		// return the latlng of that sucker
		return {
			latlng: Object.assign({}, C),
			segment: closestSegment,
			distance: shortestDistance,
		};
	},

	_getClosestPointOnSegment: function (map, latlng, latlngA, latlngB) {
		var maxzoom = map.getMaxZoom();
		if (maxzoom === Infinity) {
			maxzoom = map.getZoom();
		}
		var P = map.project(latlng, maxzoom);
		var A = map.project(latlngA, maxzoom);
		var B = map.project(latlngB, maxzoom);
		var closest = L.LineUtil.closestPointOnSegment(P, A, B);
		return map.unproject(closest, maxzoom);
	},
	_getDistanceToSegment: function (map, latlng, latlngA, latlngB) {
		var P = map.latLngToLayerPoint(latlng);
		var A = map.latLngToLayerPoint(latlngA);
		var B = map.latLngToLayerPoint(latlngB);
		return L.LineUtil.pointToSegmentDistance(P, A, B);
	},
	_getDistance: function (map, latlngA, latlngB) {
		return map.latLngToLayerPoint(latlngA).distanceTo(map.latLngToLayerPoint(latlngB));
	},
});




