import { t as __commonJSMin } from "./chunk-B4lejLz5.js";
import { n as require_react } from "./jsx-runtime-BIjMMerj.js";
import { $ as $getSlot, $r as getRootOwnerDocument, A as $getAdjacentSiblingOrParentSiblingCaret, Ar as createCommand, At as $isTabNode, B as $getDOMTextNode, Bn as IS_APPLE, C as $extendCaretToRange, Ci as mergeRegister, Cr as TabNode, Ct as $isRangeSelection, Di as registerEventListeners, Dn as DecoratorNode, E as $fullReconcile, Ei as registerEventListener, Er as addClassNamesToElement, F as $getChildCaret, Fi as stopLexicalPropagation, Fn as INDENT_CONTENT_COMMAND, Fr as defineExtension, H as $getEditor, Ht as $removeTextFromCaretRange, Ii as toggleTextFormatType, It as $normalizeCaret, J as $getNodeFromDOMNode, K as $getNodeByKey, L as $getChildCaretOrSelf, Lr as flipDirection, Lt as $normalizeSelection, M as $getCaretRange, Mt as $isTextPointCaret, N as $getCaretRangeInDirection, Nn as HISTORY_MERGE_TAG, Nr as createState, Nt as $isTokenOrSegmented, O as $getAdjacentChildCaret, Oi as removeClassNamesFromElement, On as ElementNode, Or as compileKeyboardShortcuts, Ot as $isSiblingCaret, P as $getCharacterOffsets, Pi as shallowMergeConfig, Q as $getSiblingCaret, Qn as KEY_DOWN_COMMAND, Qr as getRegisteredSubtypeMap, Qt as $setState, R as $getCollapsedCaretRange, Rn as INSERT_TAB_COMMAND, Rr as getActiveElement, S as $createTextNode, Si as makeStepwiseIterator, Sr as TEXT_TYPE_TO_FORMAT, Un as IS_FIREFOX, Ur as getDOMSelectionPoints, Ut as $rewindSiblingCaret, V as $getDocument, Vr as getDOMSelection, Wt as $selectAll, X as $getRoot, Xt as $setSelectionFromCaretRange, Y as $getPreviousSelection, Yt as $setSelection, Z as $getSelection, Zr as getParentElement, _ as $createParagraphNode, _n as CONTROL_OR_META, br as SKIP_SCROLL_INTO_VIEW_TAG, bt as $isLineBreakNode, c as $caretRangeFromSelection, cn as CAN_USE_DOM, d as $comparePointCaretNext, dn as CLICK_COMMAND, dt as $isBlockElementNode, ei as getStaticNodeConfig, en as $splitAtPointCaretNext, et as $getSlotFrame, fi as isHTMLElement, ft as $isChildCaret, g as $createNodeSelection, gr as SELECT_ALL_COMMAND, gt as $isExtendableTextPointCaret, ht as $isElementNode, it as $getState, j as $getCaretInDirection, jr as createEditor, jt as $isTextNode, ki as safeCast, kt as $isSlotHost, l as $cloneWithProperties, ln as CLEAR_EDITOR_COMMAND, lt as $insertNodeToNearestRootAtCaret, mn as COMPOSITION_START_COMMAND, mr as SELECTION_CHANGE_COMMAND, mt as $isEditorState, nn as $updateDOMSelection, nr as KEY_TAB_COMMAND, oi as isDOMNode, p as $create, pr as RootNode, pt as $isDecoratorNode, qr as getDOMTextNode$1, rr as LineBreakNode, rt as $getSlotNames, s as $caretFromPoint, sr as OUTDENT_CONTENT_COMMAND, ti as getStyleObjectFromCSS, tt as $getSlotHost, u as $cloneWithPropertiesEphemeral, ui as isExactShortcutMatch, ur as ParagraphNode, w as $findMatchingParent, wr as TextNode, wt as $isRootNode, xi as keyboardEventMaskForPlatform, xr as SKIP_SELECTION_FOCUS_TAG, xt as $isNodeSelection, y as $createRangeSelection, z as $getDOMSlot, zn as INTERNAL_$isBlock } from "./LexicalComposerContext.dev-D0rl1IDz.js";
//#region ../../node_modules/.pnpm/react-dom@19.2.5_react@19.2.5/node_modules/react-dom/cjs/react-dom.production.js
/**
* @license React
* react-dom.production.js
*
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
var require_react_dom_production = /* @__PURE__ */ __commonJSMin(((exports) => {
	var React = require_react();
	function formatProdErrorMessage(code) {
		var url = "https://react.dev/errors/" + code;
		if (1 < arguments.length) {
			url += "?args[]=" + encodeURIComponent(arguments[1]);
			for (var i = 2; i < arguments.length; i++) url += "&args[]=" + encodeURIComponent(arguments[i]);
		}
		return "Minified React error #" + code + "; visit " + url + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
	}
	function noop() {}
	var Internals = {
		d: {
			f: noop,
			r: function() {
				throw Error(formatProdErrorMessage(522));
			},
			D: noop,
			C: noop,
			L: noop,
			m: noop,
			X: noop,
			S: noop,
			M: noop
		},
		p: 0,
		findDOMNode: null
	}, REACT_PORTAL_TYPE = Symbol.for("react.portal");
	function createPortal$1(children, containerInfo, implementation) {
		var key = 3 < arguments.length && void 0 !== arguments[3] ? arguments[3] : null;
		return {
			$$typeof: REACT_PORTAL_TYPE,
			key: null == key ? null : "" + key,
			children,
			containerInfo,
			implementation
		};
	}
	var ReactSharedInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
	function getCrossOriginStringAs(as, input) {
		if ("font" === as) return "";
		if ("string" === typeof input) return "use-credentials" === input ? input : "";
	}
	exports.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = Internals;
	exports.createPortal = function(children, container) {
		var key = 2 < arguments.length && void 0 !== arguments[2] ? arguments[2] : null;
		if (!container || 1 !== container.nodeType && 9 !== container.nodeType && 11 !== container.nodeType) throw Error(formatProdErrorMessage(299));
		return createPortal$1(children, container, null, key);
	};
	exports.flushSync = function(fn) {
		var previousTransition = ReactSharedInternals.T, previousUpdatePriority = Internals.p;
		try {
			if (ReactSharedInternals.T = null, Internals.p = 2, fn) return fn();
		} finally {
			ReactSharedInternals.T = previousTransition, Internals.p = previousUpdatePriority, Internals.d.f();
		}
	};
	exports.preconnect = function(href, options) {
		"string" === typeof href && (options ? (options = options.crossOrigin, options = "string" === typeof options ? "use-credentials" === options ? options : "" : void 0) : options = null, Internals.d.C(href, options));
	};
	exports.prefetchDNS = function(href) {
		"string" === typeof href && Internals.d.D(href);
	};
	exports.preinit = function(href, options) {
		if ("string" === typeof href && options && "string" === typeof options.as) {
			var as = options.as, crossOrigin = getCrossOriginStringAs(as, options.crossOrigin), integrity = "string" === typeof options.integrity ? options.integrity : void 0, fetchPriority = "string" === typeof options.fetchPriority ? options.fetchPriority : void 0;
			"style" === as ? Internals.d.S(href, "string" === typeof options.precedence ? options.precedence : void 0, {
				crossOrigin,
				integrity,
				fetchPriority
			}) : "script" === as && Internals.d.X(href, {
				crossOrigin,
				integrity,
				fetchPriority,
				nonce: "string" === typeof options.nonce ? options.nonce : void 0
			});
		}
	};
	exports.preinitModule = function(href, options) {
		if ("string" === typeof href) if ("object" === typeof options && null !== options) {
			if (null == options.as || "script" === options.as) {
				var crossOrigin = getCrossOriginStringAs(options.as, options.crossOrigin);
				Internals.d.M(href, {
					crossOrigin,
					integrity: "string" === typeof options.integrity ? options.integrity : void 0,
					nonce: "string" === typeof options.nonce ? options.nonce : void 0
				});
			}
		} else options ?? Internals.d.M(href);
	};
	exports.preload = function(href, options) {
		if ("string" === typeof href && "object" === typeof options && null !== options && "string" === typeof options.as) {
			var as = options.as, crossOrigin = getCrossOriginStringAs(as, options.crossOrigin);
			Internals.d.L(href, as, {
				crossOrigin,
				integrity: "string" === typeof options.integrity ? options.integrity : void 0,
				nonce: "string" === typeof options.nonce ? options.nonce : void 0,
				type: "string" === typeof options.type ? options.type : void 0,
				fetchPriority: "string" === typeof options.fetchPriority ? options.fetchPriority : void 0,
				referrerPolicy: "string" === typeof options.referrerPolicy ? options.referrerPolicy : void 0,
				imageSrcSet: "string" === typeof options.imageSrcSet ? options.imageSrcSet : void 0,
				imageSizes: "string" === typeof options.imageSizes ? options.imageSizes : void 0,
				media: "string" === typeof options.media ? options.media : void 0
			});
		}
	};
	exports.preloadModule = function(href, options) {
		if ("string" === typeof href) if (options) {
			var crossOrigin = getCrossOriginStringAs(options.as, options.crossOrigin);
			Internals.d.m(href, {
				as: "string" === typeof options.as && "script" !== options.as ? options.as : void 0,
				crossOrigin,
				integrity: "string" === typeof options.integrity ? options.integrity : void 0
			});
		} else Internals.d.m(href);
	};
	exports.requestFormReset = function(form) {
		Internals.d.r(form);
	};
	exports.unstable_batchedUpdates = function(fn, a) {
		return fn(a);
	};
	exports.useFormState = function(action, initialState, permalink) {
		return ReactSharedInternals.H.useFormState(action, initialState, permalink);
	};
	exports.useFormStatus = function() {
		return ReactSharedInternals.H.useHostTransitionStatus();
	};
	exports.version = "19.2.5";
}));
//#endregion
//#region ../../node_modules/.pnpm/react-dom@19.2.5_react@19.2.5/node_modules/react-dom/index.js
var require_react_dom = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function checkDCE() {
		if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === "undefined" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE !== "function") return;
		try {
			__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(checkDCE);
		} catch (err) {
			console.error(err);
		}
	}
	checkDCE();
	module.exports = require_react_dom_production();
}));
//#endregion
//#region ../lexical-selection/dist/LexicalSelection.dev.mjs
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function formatDevErrorMessage$2(message) {
	throw new Error(message);
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function getDOMTextNode(element) {
	let node = element;
	while (node != null) {
		if (node.nodeType === Node.TEXT_NODE) return node;
		node = node.firstChild;
	}
	return null;
}
function getDOMIndexWithinParent(node) {
	const parent = node.parentNode;
	if (parent == null) throw new Error("Should never happen");
	return [parent, Array.from(parent.childNodes).indexOf(node)];
}
/**
* Creates a selection range for the DOM.
* @param editor - The lexical editor.
* @param anchorNode - The anchor node of a selection.
* @param _anchorOffset - The amount of space offset from the anchor to the focus.
* @param focusNode - The current focus.
* @param _focusOffset - The amount of space offset from the focus to the anchor.
* @returns The range of selection for the DOM that was created.
*/
function createDOMRange(editor, anchorNode, _anchorOffset, focusNode, _focusOffset) {
	const anchorKey = anchorNode.getKey();
	const focusKey = focusNode.getKey();
	const range = getRootOwnerDocument(editor.getRootElement()).createRange();
	let anchorDOM = editor.getElementByKey(anchorKey);
	let focusDOM = editor.getElementByKey(focusKey);
	let anchorOffset = _anchorOffset;
	let focusOffset = _focusOffset;
	if ($isTextNode(anchorNode)) anchorDOM = getDOMTextNode(anchorDOM);
	if ($isTextNode(focusNode)) focusDOM = getDOMTextNode(focusDOM);
	if (anchorNode === void 0 || focusNode === void 0 || anchorDOM === null || focusDOM === null) return null;
	if (anchorDOM.nodeName === "BR") [anchorDOM, anchorOffset] = getDOMIndexWithinParent(anchorDOM);
	if (focusDOM.nodeName === "BR") [focusDOM, focusOffset] = getDOMIndexWithinParent(focusDOM);
	const firstChild = anchorDOM.firstChild;
	if (anchorDOM === focusDOM && firstChild != null && firstChild.nodeName === "BR" && anchorOffset === 0 && focusOffset === 0) focusOffset = 1;
	try {
		range.setStart(anchorDOM, anchorOffset);
		range.setEnd(focusDOM, focusOffset);
	} catch (_e) {
		return null;
	}
	if (range.collapsed && (anchorOffset !== focusOffset || anchorKey !== focusKey)) {
		range.setStart(focusDOM, focusOffset);
		range.setEnd(anchorDOM, anchorOffset);
	}
	return range;
}
/**
* Creates DOMRects, generally used to help the editor find a specific location on the screen.
* @param editor - The lexical editor
* @param range - A fragment of a document that can contain nodes and parts of text nodes.
* @returns The selectionRects as an array.
*/
function createRectsFromDOMRange(editor, range) {
	const rootElement = editor.getRootElement();
	if (rootElement === null) return [];
	const rootRect = rootElement.getBoundingClientRect();
	const computedStyle = getComputedStyle(rootElement);
	const rootPadding = parseFloat(computedStyle.paddingLeft) + parseFloat(computedStyle.paddingRight);
	const selectionRects = Array.from(range.getClientRects());
	let selectionRectsLength = selectionRects.length;
	selectionRects.sort((a, b) => {
		const top = a.top - b.top;
		if (Math.abs(top) <= 3) return a.left - b.left;
		return top;
	});
	let prevRect;
	for (let i = 0; i < selectionRectsLength; i++) {
		const selectionRect = selectionRects[i];
		const isOverlappingRect = prevRect && prevRect.top <= selectionRect.top && prevRect.top + prevRect.height > selectionRect.top && prevRect.left + prevRect.width > selectionRect.left;
		const selectionSpansElement = selectionRect.width + rootPadding === rootRect.width;
		if (isOverlappingRect || selectionSpansElement) {
			selectionRects.splice(i--, 1);
			selectionRectsLength--;
			continue;
		}
		prevRect = selectionRect;
	}
	return selectionRects;
}
/**
* Serializes a style object into a CSS declaration string, the inverse of
* {@link getStyleObjectFromCSS}.
* @param styles - An object mapping CSS property names to their values.
* @returns A CSS string of the form `prop: value;` for each entry, concatenated together.
*/
function getCSSFromStyleObject(styles) {
	let css = "";
	for (const style in styles) if (style) css += `${style}: ${styles[style]};`;
	return css;
}
/**
* Gets the computed DOM styles of the element.
* @param element - The node to check the styles for.
* @returns the computed styles of the element or null if there is no DOM element or no default view for the document.
*/
function $getComputedStyleForElement(element) {
	const domElement = $getEditor().getElementByKey(element.getKey());
	if (domElement === null) return null;
	const view = domElement.ownerDocument.defaultView;
	if (view === null) return null;
	return view.getComputedStyle(domElement);
}
/**
* Gets the computed DOM styles of the parent of the node.
* @param node - The node to check its parent's styles for.
* @returns the computed styles of the node, or null if the node has no parent,
* there is no DOM element, or there is no default view for the document.
*/
function $getComputedStyleForParent(node) {
	const parent = $isRootNode(node) ? node : node.getParent();
	return parent && $getComputedStyleForElement(parent);
}
/**
* Determines whether a node's parent is RTL.
* @param node - The node to check whether it is RTL.
* @returns whether the node is RTL.
*/
function $isParentRTL(node) {
	const styles = $getComputedStyleForParent(node);
	return styles !== null && styles.direction === "rtl";
}
/**
* Generally used to append text content to HTML and JSON. Grabs the text content and "slices"
* it to be generated into the new TextNode.
* @param selection - The selection containing the node whose TextNode is to be edited.
* @param textNode - The TextNode to be edited.
* @param mutates - 'clone' to return a clone before mutating, 'self' to update in-place
* @returns The updated TextNode or clone.
*/
function $sliceSelectedTextNodeContent(selection, textNode, mutates = "self") {
	const anchorAndFocus = selection.getStartEndPoints();
	if (textNode.isSelected(selection) && !$isTokenOrSegmented(textNode) && anchorAndFocus !== null) {
		const [anchor, focus] = anchorAndFocus;
		const isBackward = selection.isBackward();
		const anchorNode = anchor.getNode();
		const focusNode = focus.getNode();
		const isAnchor = textNode.is(anchorNode);
		const isFocus = textNode.is(focusNode);
		if (isAnchor || isFocus) {
			const [anchorOffset, focusOffset] = $getCharacterOffsets(selection);
			const isSame = anchorNode.is(focusNode);
			const isFirst = textNode.is(isBackward ? focusNode : anchorNode);
			const isLast = textNode.is(isBackward ? anchorNode : focusNode);
			let startOffset = 0;
			let endOffset = void 0;
			if (isSame) {
				startOffset = anchorOffset > focusOffset ? focusOffset : anchorOffset;
				endOffset = anchorOffset > focusOffset ? anchorOffset : focusOffset;
			} else if (isFirst) {
				startOffset = isBackward ? focusOffset : anchorOffset;
				endOffset = void 0;
			} else if (isLast) {
				const offset = isBackward ? anchorOffset : focusOffset;
				startOffset = 0;
				endOffset = offset;
			}
			const text = textNode.__text.slice(startOffset, endOffset);
			if (text !== textNode.__text) {
				if (mutates === "clone") textNode = $cloneWithPropertiesEphemeral(textNode);
				textNode.__text = text;
			}
		}
	}
	return textNode;
}
/**
* Determines if the current selection is at the end of the node.
* @param point - The point of the selection to test.
* @returns true if the provided point offset is in the last possible position, false otherwise.
*/
function $isAtNodeEnd(point) {
	if (point.type === "text") return point.offset === point.getNode().getTextContentSize();
	const node = point.getNode();
	if (!$isElementNode(node)) formatDevErrorMessage$2(`isAtNodeEnd: node must be a TextNode or ElementNode`);
	return point.offset === node.getChildrenSize();
}
/**
* Trims text from a node in order to shorten it, eg. to enforce a text's max length. If it deletes text
* that is an ancestor of the anchor then it will leave 2 indents, otherwise, if no text content exists, it deletes
* the TextNode. It will move the focus to either the end of any left over text or beginning of a new TextNode.
* @param editor - The lexical editor.
* @param anchor - The anchor of the current selection, where the selection should be pointing.
* @param delCount - The amount of characters to delete. Useful as a dynamic variable eg. textContentSize - maxLength;
*/
function $trimTextContentFromAnchor(editor, anchor, delCount) {
	let currentNode = anchor.getNode();
	let remaining = delCount;
	if ($isElementNode(currentNode)) {
		const descendantNode = currentNode.getDescendantByIndex(anchor.offset);
		if (descendantNode !== null) currentNode = descendantNode;
	}
	while (remaining > 0 && currentNode !== null) {
		if ($isElementNode(currentNode)) {
			const lastDescendant = currentNode.getLastDescendant();
			if (lastDescendant !== null) currentNode = lastDescendant;
		}
		let nextNode = currentNode.getPreviousSibling();
		let additionalElementWhitespace = 0;
		if (nextNode === null) {
			let parent = currentNode.getParentOrThrow();
			let parentSibling = parent.getPreviousSibling();
			while (parentSibling === null) {
				parent = parent.getParent();
				if (parent === null) {
					nextNode = null;
					break;
				}
				parentSibling = parent.getPreviousSibling();
			}
			if (parent !== null) {
				additionalElementWhitespace = parent.isInline() ? 0 : 2;
				nextNode = parentSibling;
			}
		}
		let text = currentNode.getTextContent();
		if (text === "" && $isElementNode(currentNode) && !currentNode.isInline()) text = "\n\n";
		const currentNodeSize = text.length;
		if (!$isTextNode(currentNode) || remaining >= currentNodeSize) {
			const parent = currentNode.getParent();
			currentNode.remove();
			if (parent != null && parent.getChildrenSize() === 0 && !$isRootNode(parent)) parent.remove();
			remaining -= currentNodeSize + additionalElementWhitespace;
			currentNode = nextNode;
		} else {
			const key = currentNode.getKey();
			const prevTextContent = editor.read("latest", () => {
				const prevNode = $getNodeByKey(key);
				if ($isTextNode(prevNode) && prevNode.isSimpleText()) return prevNode.getTextContent();
				return null;
			});
			const offset = currentNodeSize - remaining;
			const slicedText = text.slice(0, offset);
			if (prevTextContent !== null && prevTextContent !== text) {
				const prevSelection = $getPreviousSelection();
				let target = currentNode;
				if (!currentNode.isSimpleText()) {
					const textNode = $createTextNode(prevTextContent);
					currentNode.replace(textNode);
					target = textNode;
				} else currentNode.setTextContent(prevTextContent);
				if ($isRangeSelection(prevSelection) && prevSelection.isCollapsed()) {
					const prevOffset = prevSelection.anchor.offset;
					target.select(prevOffset, prevOffset);
				}
			} else if (currentNode.isSimpleText()) {
				const isSelected = anchor.key === key;
				let anchorOffset = anchor.offset;
				if (anchorOffset < remaining) anchorOffset = currentNodeSize;
				const splitStart = isSelected ? anchorOffset - remaining : 0;
				const splitEnd = isSelected ? anchorOffset : offset;
				if (isSelected && splitStart === 0) {
					const [excessNode] = currentNode.splitText(splitStart, splitEnd);
					excessNode.remove();
				} else {
					const [, excessNode] = currentNode.splitText(splitStart, splitEnd);
					excessNode.remove();
				}
			} else {
				const textNode = $createTextNode(slicedText);
				currentNode.replace(textNode);
			}
			remaining = 0;
		}
	}
}
/**
* Applies the provided styles to the given TextNode, ElementNode, or
* collapsed RangeSelection.
*
* @param target - The TextNode, ElementNode, or collapsed RangeSelection to apply the styles to
* @param patch - The patch to apply, which can include multiple styles. \\{CSSProperty: value\\} . Can also accept a function that returns the new property value.
*/
function $patchStyle(target, patch) {
	if (!($isRangeSelection(target) ? target.isCollapsed() : $isTextNode(target) || $isElementNode(target))) formatDevErrorMessage$2(`$patchStyle must only be called with a TextNode, ElementNode, or collapsed RangeSelection`);
	const prevStyles = getStyleObjectFromCSS($isRangeSelection(target) ? target.style : $isTextNode(target) ? target.getStyle() : target.getTextStyle());
	const newCSSText = getCSSFromStyleObject(Object.entries(patch).reduce((styles, [key, value]) => {
		if (typeof value === "function") styles[key] = value(prevStyles[key], target);
		else if (value === null) delete styles[key];
		else styles[key] = value;
		return styles;
	}, { ...prevStyles }));
	if ($isRangeSelection(target) || $isTextNode(target)) target.setStyle(newCSSText);
	else target.setTextStyle(newCSSText);
}
/**
* Applies the provided styles to the TextNodes in the provided Selection.
* Will update partially selected TextNodes by splitting the TextNode and applying
* the styles to the appropriate one.
* @param selection - The selected node(s) to update.
* @param patch - The patch to apply, which can include multiple styles. \\{CSSProperty: value\\} . Can also accept a function that returns the new property value.
*/
function $patchStyleText(selection, patch) {
	const patchedElementKeys = /* @__PURE__ */ new Set();
	if ($isRangeSelection(selection) && selection.isCollapsed()) {
		$patchStyle(selection, patch);
		const emptyNode = selection.anchor.getNode();
		if ($isElementNode(emptyNode) && emptyNode.isEmpty()) {
			patchedElementKeys.add(emptyNode.getKey());
			$patchStyle(emptyNode, patch);
		}
	}
	$forEachSelectedTextNode((textNode) => {
		$patchStyle(textNode, patch);
	});
	const nodes = selection.getNodes();
	if (nodes.length > 0) for (const node of nodes) {
		if (!$isElementNode(node) || !node.canBeEmpty() || node.getChildrenSize() !== 0) continue;
		const key = node.getKey();
		if (patchedElementKeys.has(key)) continue;
		patchedElementKeys.add(key);
		$patchStyle(node, patch);
	}
}
function $forEachSelectedTextNode(fn) {
	const selection = $getSelection();
	if (!selection) return;
	const slicedTextNodes = /* @__PURE__ */ new Map();
	const getSliceIndices = (node) => slicedTextNodes.get(node.getKey()) || [0, node.getTextContentSize()];
	if ($isRangeSelection(selection)) {
		for (const slice of $caretRangeFromSelection(selection).getTextSlices()) if (slice) slicedTextNodes.set(slice.caret.origin.getKey(), slice.getSliceIndices());
	}
	const selectedNodes = selection.getNodes();
	for (const selectedNode of selectedNodes) {
		if (!($isTextNode(selectedNode) && selectedNode.canHaveFormat())) continue;
		const [startOffset, endOffset] = getSliceIndices(selectedNode);
		if (endOffset === startOffset) continue;
		if ($isTokenOrSegmented(selectedNode) || startOffset === 0 && endOffset === selectedNode.getTextContentSize()) fn(selectedNode);
		else {
			const replacement = selectedNode.splitText(startOffset, endOffset)[startOffset === 0 ? 0 : 1];
			fn(replacement);
		}
	}
	if ($isRangeSelection(selection) && selection.anchor.type === "text" && selection.focus.type === "text" && selection.anchor.key === selection.focus.key) $ensureForwardRangeSelection(selection);
}
/**
* Ensure that the given RangeSelection is not backwards. If it
* is backwards, then the anchor and focus points will be swapped
* in-place. Ensuring that the selection is a writable RangeSelection
* is the responsibility of the caller (e.g. in a read-only context
* you will want to clone $getSelection() before using this).
*
* @param selection a writable RangeSelection
*/
function $ensureForwardRangeSelection(selection) {
	if (selection.isBackward()) {
		const { anchor, focus } = selection;
		const { key, offset, type } = anchor;
		anchor.set(focus.key, focus.offset, focus.type);
		focus.set(key, offset, type);
	}
}
function $copyBlockFormatIndent(srcNode, destNode) {
	const format = srcNode.getFormatType();
	const indent = srcNode.getIndent();
	if (format !== destNode.getFormatType()) destNode.setFormat(format);
	if (indent !== destNode.getIndent()) destNode.setIndent(indent);
}
/**
* Determine whether a point sits at the leading ('previous') or trailing
* ('next') edge of `element`'s content — i.e. there is no content between the
* point and that edge of the element.
*
* This is the caret-based generalization of {@link $isAtNodeEnd}. An empty
* `element` is considered to be at both of its edges. `@lexical/utils`
* re-exports this as the direction-specific `$isAtStartOfNode` /
* `$isAtEndOfNode` helpers.
*
* @param point - The point to test.
* @param element - The ancestor element whose edge is tested.
* @param direction - 'previous' for the start of `element`, 'next' for the end.
*/
function $isAtEdgeOfElement(point, element, direction) {
	let caret = $caretFromPoint(point, direction);
	if ($isExtendableTextPointCaret(caret)) return false;
	for (; caret; caret = caret.getParentCaret()) {
		const parent = caret.getParentAtCaret();
		if (!parent || caret.getNodeAtCaret()) return false;
		if (element.is(parent)) return true;
	}
	return false;
}
/**
* Determine whether a point sits at the edge of a block in the given
* direction: 'previous' for the start of the block, 'next' for the end.
*
* Unlike {@link $isAtEdgeOfElement}, an empty block is treated as not being at
* the edge: when an ElementNode is empty it's not possible to distinguish if
* the selection's intent is the entire block or the edge so we consider it to
* be the entire block.
*/
function $isPointAtBlockEdge(point, block, direction) {
	const node = point.getNode();
	if ($isElementNode(node) && node.isEmpty()) return false;
	return $isAtEdgeOfElement(point, block, direction);
}
/**
* Converts all nodes in the selection that are of one block type to another.
* @param selection - The selected blocks to be converted.
* @param $createElement - The function that creates the node. eg. $createParagraphNode.
* @param $afterCreateElement - The function that updates the new node based on the previous one ($copyBlockFormatIndent by default)
*/
function $setBlocksType(selection, $createElement, $afterCreateElement = $copyBlockFormatIndent) {
	if (!selection) return;
	const anchorAndFocus = selection.getStartEndPoints();
	let skipFocus = false;
	let focusBlock = null;
	const blockMap = /* @__PURE__ */ new Map();
	if (anchorAndFocus) {
		const [anchor, focus] = anchorAndFocus;
		const anchorBlock = $findMatchingParent(anchor.getNode(), INTERNAL_$isBlock);
		focusBlock = $findMatchingParent(focus.getNode(), INTERNAL_$isBlock);
		const direction = selection.isBackward() ? "previous" : "next";
		skipFocus = $isElementNode(focusBlock) && !focusBlock.is(anchorBlock) && $isPointAtBlockEdge(focus, focusBlock, flipDirection(direction));
		if ($isElementNode(anchorBlock)) blockMap.set(anchorBlock.getKey(), anchorBlock);
		if ($isElementNode(focusBlock) && !skipFocus) blockMap.set(focusBlock.getKey(), focusBlock);
	}
	for (const node of selection.getNodes()) if ($isElementNode(node) && INTERNAL_$isBlock(node)) {
		if (skipFocus && node.is(focusBlock)) continue;
		blockMap.set(node.getKey(), node);
	} else if (!anchorAndFocus) {
		const ancestorBlock = $findMatchingParent(node, INTERNAL_$isBlock);
		if ($isElementNode(ancestorBlock)) blockMap.set(ancestorBlock.getKey(), ancestorBlock);
	}
	for (const prevNode of blockMap.values()) {
		if ($getSlotHost(prevNode) !== null) continue;
		const element = $createElement();
		$afterCreateElement(prevNode, element);
		prevNode.replace(element, true);
	}
}
/**
* Tests if the selection's parent element has vertical writing mode.
* @param selection - The selection whose parent to test.
* @returns true if the selection's parent has vertical writing mode (writing-mode: vertical-rl), false otherwise.
*/
function $isEditorVerticalOrientation(selection) {
	const computedStyle = $getComputedStyle(selection);
	return computedStyle !== null && computedStyle.writingMode === "vertical-rl";
}
/**
* Gets the computed DOM styles of the parent of the selection's anchor node.
* @param selection - The selection to check the styles for.
* @returns the computed styles of the node or null if there is no DOM element or no default view for the document.
*/
function $getComputedStyle(selection) {
	const anchorNode = selection.anchor.getNode();
	if ($isElementNode(anchorNode)) return $getComputedStyleForElement(anchorNode);
	return $getComputedStyleForParent(anchorNode);
}
/**
* Determines if the default character selection should be overridden. Used with DecoratorNodes
* @param selection - The selection whose default character selection may need to be overridden.
* @param isBackward - Is the selection backwards (the focus comes before the anchor)?
* @returns true if it should be overridden, false if not.
*/
function $shouldOverrideDefaultCharacterSelection(selection, isBackward) {
	let adjustedIsBackward = $isEditorVerticalOrientation(selection) ? !isBackward : isBackward;
	if ($isParentElementRTL(selection)) adjustedIsBackward = !adjustedIsBackward;
	const focusCaret = $caretFromPoint(selection.focus, adjustedIsBackward ? "previous" : "next");
	if ($isExtendableTextPointCaret(focusCaret)) return false;
	if ($isTextPointCaret(focusCaret) && !$isTabNode(focusCaret.origin) && focusCaret.origin.isUnmergeable()) {
		const sibling = focusCaret.getNodeAtCaret();
		if ($isTextNode(sibling) && !$isTabNode(sibling)) return true;
	}
	for (const nextCaret of $extendCaretToRange(focusCaret)) {
		if ($isChildCaret(nextCaret)) return !nextCaret.origin.isInline();
		else if ($isElementNode(nextCaret.origin)) continue;
		else if ($isDecoratorNode(nextCaret.origin)) return true;
		break;
	}
	return false;
}
/**
* Moves the selection according to the arguments.
* @param selection - The selected text or nodes.
* @param isHoldingShift - Is the shift key being held down during the operation.
* @param isBackward - Is the selection selected backwards (the focus comes before the anchor)?
* @param granularity - The distance to adjust the current selection.
*/
function $moveCaretSelection(selection, isHoldingShift, isBackward, granularity) {
	selection.modify(isHoldingShift ? "extend" : "move", isBackward, granularity);
}
/**
* Tests a parent element for right to left direction.
* @param selection - The selection whose parent is to be tested.
* @returns true if the selections' parent element has a direction of 'rtl' (right to left), false otherwise.
*/
function $isParentElementRTL(selection) {
	const computedStyle = $getComputedStyle(selection);
	return computedStyle !== null && computedStyle.direction === "rtl";
}
/**
* Moves selection by character according to arguments.
* @param selection - The selection of the characters to move.
* @param isHoldingShift - Is the shift key being held down during the operation.
* @param isBackward - Is the selection backward (the focus comes before the anchor)?
*/
function $moveCharacter(selection, isHoldingShift, isBackward) {
	const isRTL = $isParentElementRTL(selection);
	const isVertical = $isEditorVerticalOrientation(selection);
	let adjustedIsBackward;
	if (isVertical) adjustedIsBackward = !isBackward;
	else if (isRTL) adjustedIsBackward = !isBackward;
	else adjustedIsBackward = isBackward;
	$moveCaretSelection(selection, isHoldingShift, adjustedIsBackward, "character");
}
/**
* Returns the current value of a CSS property for Nodes, if set. If not set, it returns the defaultValue.
* @param node - The node whose style value to get.
* @param styleProperty - The CSS style property.
* @param defaultValue - The default value for the property.
* @returns The value of the property for node.
*/
function $getNodeStyleValueForProperty(node, styleProperty, defaultValue) {
	const styleObject = getStyleObjectFromCSS(node.getStyle());
	if (styleObject !== null) return styleObject[styleProperty] || defaultValue;
	return defaultValue;
}
/**
* Returns the current value of a CSS property for TextNodes in the Selection, if set. If not set, it returns the defaultValue.
* If all TextNodes do not have the same value, it returns an empty string.
* @param selection - The selection of TextNodes whose value to find.
* @param styleProperty - The CSS style property.
* @param defaultValue - The default value for the property, defaults to an empty string.
* @returns The value of the property for the selected TextNodes.
*/
function $getSelectionStyleValueForProperty(selection, styleProperty, defaultValue = "") {
	let styleValue = null;
	const nodes = selection.getNodes();
	let startNode;
	let endNode;
	if ($isRangeSelection(selection)) {
		if (selection.isCollapsed() && selection.style !== "") {
			const styleObject = getStyleObjectFromCSS(selection.style);
			if (styleObject !== null && styleProperty in styleObject) return styleObject[styleProperty];
		}
		const { anchor, focus } = selection;
		const isBackward = selection.isBackward();
		const firstNode = isBackward ? focus.getNode() : anchor.getNode();
		const lastNode = isBackward ? anchor.getNode() : focus.getNode();
		const startOffset = isBackward ? focus.offset : anchor.offset;
		const endOffset = isBackward ? anchor.offset : focus.offset;
		if ($isTextNode(firstNode) && startOffset === firstNode.getTextContentSize()) startNode = firstNode;
		if (endOffset === 0) endNode = lastNode;
	}
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if ($isTextNode(node) && !node.is(i === 0 ? startNode : endNode)) {
			const nodeStyleValue = $getNodeStyleValueForProperty(node, styleProperty, defaultValue);
			if (styleValue === null) styleValue = nodeStyleValue;
			else if (styleValue !== nodeStyleValue) {
				styleValue = "";
				break;
			}
		}
	}
	return styleValue === null ? defaultValue : styleValue;
}
//#endregion
//#region ../lexical-utils/dist/LexicalUtils.dev.mjs
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function formatDevErrorMessage$1(message) {
	throw new Error(message);
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Dedupe a list of selection client-rects before they are drawn as fills.
*
* `Range.getClientRects()` can return rects that are duplicated or contained
* within another, and WebKit in particular emits a spurious wider rect alongside
* the real text rect on some blocks (balanced or letter-spaced headings are the
* reproducible case). Drawn as semi-transparent fills, duplicates read brighter
* than a single rect, and the wider rect paints the "extra empty selection area"
* reported in facebook/lexical#7106.
*
* This drops zero-area rects and any rect that contains another, keeping the
* smaller text-hugging one, with a 1px tolerance for sub-pixel jitter. The
* assumption is that genuine same-line rects are horizontally disjoint (one rect
* per visual row; inline boxes on a row tile side by side), so containment only
* holds for the duplicate or spurious-wider cases, never for a legitimate
* sub-fragment that should be kept.
*
* On the `createRectsFromDOMRange` path (e.g. `positionNodeOnRange`): that
* helper's own `selectionSpansElement` filter already drops the full-block-width
* spurious rect, so there this mainly prevents the duplicate-doubling. The #7106
* extra-area paint is addressed for consumers that feed raw `getClientRects()`,
* where `selectionSpansElement` does not run — that is the path that needs it.
*
* Known limitation: the disjoint assumption holds for normal flow. Overlapping
* inline content — a negative margin, a transform, or a baseline-shifted inline
* decorator — can place a real sub-fragment inside a wider real-text rect on the
* same row; if a sub-pixel top offset also lets both clear
* `createRectsFromDOMRange`'s asymmetric overlap filter, keep-smaller drops the
* wider rect and under-paints the glyphs it uniquely covered. There is no
* rect-only fix: that wider rect is geometrically indistinguishable from the
* spurious-wider (#7106) rect, so keeping it would re-introduce the extra-area
* paint. See the under-paint characterization browser test.
*
* Typed on the structural subset of `DOMRect` it reads, so it accepts a live
* `DOMRectList` from `getClientRects()` as well as the `DOMRect[]` returned by
* `createRectsFromDOMRange`, and is unit-testable without a DOM.
*/
function dedupeSelectionRects(rects) {
	const contains = (a, b) => b.left >= a.left - 1 && b.top >= a.top - 1 && b.right <= a.right + 1 && b.bottom <= a.bottom + 1;
	const kept = [];
	for (const rect of Array.from(rects)) {
		if (rect.width < .5 || rect.height < .5) continue;
		if (kept.some((keptRect) => contains(rect, keptRect))) continue;
		for (let i = kept.length - 1; i >= 0; i--) if (contains(kept[i], rect)) kept.splice(i, 1);
		kept.push(rect);
	}
	return kept;
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function px(value) {
	return `${value}px`;
}
var mutationObserverConfig = {
	attributes: true,
	characterData: true,
	childList: true,
	subtree: true
};
function prependDOMNode(parent, node) {
	parent.insertBefore(node, parent.firstChild);
}
/**
* Place one or multiple newly created Nodes at the passed Range's position.
* Multiple nodes will only be created when the Range spans multiple lines (aka
* client rects).
*
* This function can come particularly useful to highlight particular parts of
* the text without interfering with the EditorState, that will often replicate
* the state across collab and clipboard.
*
* This function accounts for DOM updates which can modify the passed Range.
* Hence, the function return to remove the listener.
*/
function mlcPositionNodeOnRange(editor, range, onReposition) {
	let rootDOMNode = null;
	let parentDOMNode = null;
	let observer = null;
	let lastNodes = [];
	const wrapperNode = getRootOwnerDocument(editor.getRootElement()).createElement("div");
	wrapperNode.style.position = "relative";
	function position() {
		if (!(rootDOMNode !== null)) formatDevErrorMessage$1(`Unexpected null rootDOMNode`);
		if (!(parentDOMNode !== null)) formatDevErrorMessage$1(`Unexpected null parentDOMNode`);
		const { left: parentLeft, top: parentTop } = parentDOMNode.getBoundingClientRect();
		const rects = dedupeSelectionRects(createRectsFromDOMRange(editor, range));
		if (!wrapperNode.isConnected) prependDOMNode(parentDOMNode, wrapperNode);
		let hasRepositioned = false;
		for (let i = 0; i < rects.length; i++) {
			const rect = rects[i];
			const rectNode = lastNodes[i] || getRootOwnerDocument(rootDOMNode).createElement("div");
			const rectNodeStyle = rectNode.style;
			if (rectNodeStyle.position !== "absolute") {
				rectNodeStyle.position = "absolute";
				hasRepositioned = true;
			}
			const left = px(rect.left - parentLeft);
			if (rectNodeStyle.left !== left) {
				rectNodeStyle.left = left;
				hasRepositioned = true;
			}
			const top = px(rect.top - parentTop);
			if (rectNodeStyle.top !== top) {
				rectNode.style.top = top;
				hasRepositioned = true;
			}
			const width = px(rect.width);
			if (rectNodeStyle.width !== width) {
				rectNode.style.width = width;
				hasRepositioned = true;
			}
			const height = px(rect.height);
			if (rectNodeStyle.height !== height) {
				rectNode.style.height = height;
				hasRepositioned = true;
			}
			if (rectNode.parentNode !== wrapperNode) {
				wrapperNode.append(rectNode);
				hasRepositioned = true;
			}
			lastNodes[i] = rectNode;
		}
		while (lastNodes.length > rects.length) {
			const node = lastNodes.pop();
			if (node != null) node.remove();
		}
		if (hasRepositioned) onReposition(lastNodes);
	}
	function stop() {
		parentDOMNode = null;
		rootDOMNode = null;
		if (observer !== null) observer.disconnect();
		observer = null;
		wrapperNode.remove();
		for (const node of lastNodes) node.remove();
		lastNodes = [];
	}
	function restart() {
		const currentRootDOMNode = editor.getRootElement();
		if (currentRootDOMNode === null) return stop();
		const currentParentDOMNode = currentRootDOMNode.parentElement;
		if (!isHTMLElement(currentParentDOMNode)) return stop();
		stop();
		rootDOMNode = currentRootDOMNode;
		parentDOMNode = currentParentDOMNode;
		observer = new MutationObserver((mutations) => {
			const nextRootDOMNode = editor.getRootElement();
			const nextParentDOMNode = nextRootDOMNode && nextRootDOMNode.parentElement;
			if (nextRootDOMNode !== rootDOMNode || nextParentDOMNode !== parentDOMNode) return restart();
			for (const mutation of mutations) if (!wrapperNode.contains(mutation.target)) return position();
		});
		observer.observe(currentParentDOMNode, mutationObserverConfig);
		position();
	}
	const removeRootListener = editor.registerRootListener(restart);
	return () => {
		removeRootListener();
		stop();
	};
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function $getOrderedSelectionPoints(selection) {
	const points = selection.getStartEndPoints();
	return selection.isBackward() ? [points[1], points[0]] : points;
}
function $rangeTargetFromPoint(editor, point, node, dom) {
	if (point.type === "text" || !$isElementNode(node)) return [($isTextNode(node) ? $getDOMTextNode(node, dom, editor) : getDOMTextNode$1(dom)) || dom, point.offset];
	else {
		const slot = $getDOMSlot(node, dom, editor);
		return [slot.element, slot.getFirstChildOffset() + point.offset];
	}
}
function $rangeFromPoints(editor, start, startNode, startDOM, end, endNode, endDOM) {
	const range = (editor._window ? editor._window.document : document).createRange();
	range.setStart(...$rangeTargetFromPoint(editor, start, startNode, startDOM));
	range.setEnd(...$rangeTargetFromPoint(editor, end, endNode, endDOM));
	return range;
}
function defaultOnReposition(domNodes) {
	for (const domNode of domNodes) {
		const domNodeStyle = domNode.style;
		if (domNodeStyle.background !== "Highlight") domNodeStyle.background = "Highlight";
		if (domNodeStyle.color !== "HighlightText") domNodeStyle.color = "HighlightText";
		if (domNodeStyle.marginTop !== px(-1.5)) domNodeStyle.marginTop = px(-1.5);
		if (domNodeStyle.paddingTop !== px(4)) domNodeStyle.paddingTop = px(4);
		if (domNodeStyle.paddingBottom !== px(0)) domNodeStyle.paddingBottom = px(0);
	}
}
/**
* Place one or multiple newly created Nodes at the current selection. Multiple
* nodes will only be created when the selection spans multiple lines (aka
* client rects).
*
* This function can come useful when you want to show the selection but the
* editor has been focused away.
*/
function markSelection(editor, onReposition = defaultOnReposition) {
	let previousAnchorNode = null;
	let previousAnchorNodeDOM = null;
	let previousAnchorOffset = null;
	let previousFocusNode = null;
	let previousFocusNodeDOM = null;
	let previousFocusOffset = null;
	let removeRangeListener = () => {};
	function compute(editorState) {
		editorState.read(() => {
			const selection = $getSelection();
			if (!$isRangeSelection(selection)) {
				previousAnchorNode = null;
				previousAnchorOffset = null;
				previousFocusNode = null;
				previousFocusOffset = null;
				removeRangeListener();
				removeRangeListener = () => {};
				return;
			}
			const [start, end] = $getOrderedSelectionPoints(selection);
			const currentStartNode = start.getNode();
			const currentStartNodeKey = currentStartNode.getKey();
			const currentStartOffset = start.offset;
			const currentEndNode = end.getNode();
			const currentEndNodeKey = currentEndNode.getKey();
			const currentEndOffset = end.offset;
			const currentStartNodeDOM = editor.getElementByKey(currentStartNodeKey);
			const currentEndNodeDOM = editor.getElementByKey(currentEndNodeKey);
			const differentStartDOM = previousAnchorNode === null || currentStartNodeDOM !== previousAnchorNodeDOM || currentStartOffset !== previousAnchorOffset || currentStartNodeKey !== previousAnchorNode.getKey();
			const differentEndDOM = previousFocusNode === null || currentEndNodeDOM !== previousFocusNodeDOM || currentEndOffset !== previousFocusOffset || currentEndNodeKey !== previousFocusNode.getKey();
			if ((differentStartDOM || differentEndDOM) && currentStartNodeDOM !== null && currentEndNodeDOM !== null) {
				const range = $rangeFromPoints(editor, start, currentStartNode, currentStartNodeDOM, end, currentEndNode, currentEndNodeDOM);
				removeRangeListener();
				removeRangeListener = mlcPositionNodeOnRange(editor, range, onReposition);
			}
			previousAnchorNode = currentStartNode;
			previousAnchorNodeDOM = currentStartNodeDOM;
			previousAnchorOffset = currentStartOffset;
			previousFocusNode = currentEndNode;
			previousFocusNodeDOM = currentEndNodeDOM;
			previousFocusOffset = currentEndOffset;
		}, { editor });
	}
	compute(editor.getEditorState());
	return mergeRegister(editor.registerUpdateListener(({ editorState }) => compute(editorState)), () => {
		removeRangeListener();
	});
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function selectionAlwaysOnDisplay(editor, onReposition) {
	let removeSelectionMark = null;
	const onSelectionChange = () => {
		const editorRootElement = editor.getRootElement();
		const targetWindow = editorRootElement !== null ? editorRootElement.ownerDocument.defaultView : null;
		const domSelection = targetWindow !== null ? targetWindow.getSelection() : null;
		const domAnchorNode = domSelection !== null ? getDOMSelectionPoints(domSelection, editorRootElement).anchorNode : null;
		if (domAnchorNode !== null && editorRootElement !== null && editorRootElement.contains(domAnchorNode)) {
			if (removeSelectionMark !== null) {
				removeSelectionMark();
				removeSelectionMark = null;
			}
		} else if (removeSelectionMark === null) removeSelectionMark = markSelection(editor, onReposition);
	};
	return editor.registerRootListener((rootElement) => {
		if (rootElement) {
			const document = rootElement.ownerDocument;
			const cleanup = mergeRegister(registerEventListener(document, "selectionchange", onSelectionChange), () => {
				if (removeSelectionMark !== null) removeSelectionMark();
			});
			onSelectionChange();
			return cleanup;
		}
	});
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Walks up from `element` and returns the nearest scrollable ancestor (or
* `ownerDocument.body` if none is found), used to keep the active typeahead
* option scrolled into view. Set `includeHidden` to also treat
* `overflow: hidden` ancestors as scroll parents.
*
* The walk crosses ShadowRoot→host (via `getParentElement`) so a
* shadow-mounted editor's scroll parent is found in the enclosing light-DOM
* ancestor chain, and the styles / body are resolved through the element's
* own realm so an iframe-mounted editor stays inside its document.
*/
function getScrollParent(element, includeHidden) {
	const ownerDocument = element.ownerDocument;
	const win = ownerDocument.defaultView || window;
	let style = win.getComputedStyle(element);
	const excludeStaticParent = style.position === "absolute";
	const overflowRegex = includeHidden ? /(auto|scroll|hidden)/ : /(auto|scroll)/;
	if (style.position === "fixed") return ownerDocument.body;
	for (let parent = element; parent = getParentElement(parent);) {
		style = win.getComputedStyle(parent);
		if (excludeStaticParent && style.position === "static") continue;
		if (overflowRegex.test(style.overflow + style.overflowY + style.overflowX)) return parent;
	}
	return ownerDocument.body;
}
/**
* Returns true if the file type matches the types passed within the acceptableMimeTypes array, false otherwise.
* The types passed must be strings and are CASE-SENSITIVE.
* eg. if file is of type 'text' and acceptableMimeTypes = ['TEXT', 'IMAGE'] the function will return false.
* @param file - The file you want to type check.
* @param acceptableMimeTypes - An array of strings of types which the file is checked against.
* @returns true if the file is an acceptable mime type, false otherwise.
*/
function isMimeType(file, acceptableMimeTypes) {
	for (const acceptableType of acceptableMimeTypes) if (file.type.startsWith(acceptableType)) return true;
	return false;
}
/**
* Lexical File Reader with:
*  1. MIME type support
*  2. batched results (HistoryPlugin compatibility)
*  3. Order aware (respects the order when multiple Files are passed)
*
* const filesResult = await mediaFileReader(files, ['image/']);
* filesResult.forEach(file => editor.dispatchCommand('INSERT_IMAGE', \\{
*   src: file.result,
* \\}));
*/
function mediaFileReader(files, acceptableMimeTypes) {
	const filesIterator = files[Symbol.iterator]();
	return new Promise((resolve, reject) => {
		const processed = [];
		const handleNextFile = () => {
			const { done, value: file } = filesIterator.next();
			if (done) return resolve(processed);
			const fileReader = new FileReader();
			fileReader.addEventListener("error", reject);
			fileReader.addEventListener("load", () => {
				const result = fileReader.result;
				if (typeof result === "string") processed.push({
					file,
					result
				});
				handleNextFile();
			});
			if (isMimeType(file, acceptableMimeTypes)) fileReader.readAsDataURL(file);
			else handleNextFile();
		};
		handleNextFile();
	});
}
/**
* "Depth-First Search" starts at the root/top node of a tree and goes as far as it can down a branch end
* before backtracking and finding a new path. Consider solving a maze by hugging either wall, moving down a
* branch until you hit a dead-end (leaf) and backtracking to find the nearest branching path and repeat.
* It will then return all the nodes found in the search in an array of objects.
* Preorder traversal is used, meaning that nodes are listed in the order of when they are FIRST encountered.
*
* Children-only spine: named slot subtrees are skipped. Use {@link $dfsWithSlots}
* when you need to descend into slots (e.g. character counting, slot-aware
* content extraction).
*
* @param startNode - The node to start the search (inclusive), if omitted, it will start at the root node.
* @param endNode - The node to end the search (inclusive), if omitted, it will find all descendants of the startingNode. If endNode
* is an ElementNode, it will stop before visiting any of its children.
* @returns An array of objects of all the nodes found by the search, including their depth into the tree.
* \\{depth: number, node: LexicalNode\\} It will always return at least 1 node (the start node).
*/
function $dfs(startNode, endNode) {
	return Array.from($dfsIterator(startNode, endNode));
}
/**
* $dfs iterator (left to right). Tree traversal is done on the fly as new values are requested with O(1) memory.
* Preorder traversal is used, meaning that nodes are iterated over in the order of when they are FIRST encountered.
*
* Children-only spine: named slot subtrees are skipped. Use {@link $dfsWithSlotsIterator}
* (or {@link $dfsWithSlots}) when you need to descend into slots — e.g. character
* counting, content extraction, or any cross-tree analysis where slotted content
* should be visited.
*
* @param startNode - The node to start the search (inclusive), if omitted, it will start at the root node.
* @param endNode - The node to end the search (inclusive), if omitted, it will find all descendants of the startingNode.
* If endNode is an ElementNode, the iterator will end as soon as it reaches the endNode (no children will be visited).
* @returns An iterator, each yielded value is a DFSNode. It will always return at least 1 node (the start node).
*/
function $dfsIterator(startNode, endNode) {
	return $dfsCaretIterator("next", startNode, endNode);
}
/**
* Like {@link $dfs}, but also descends into named slots. Slots are not on the
* linked-list spine, so each host's slot subtrees are emitted slots-first,
* right after the host node and before its linked-list children.
* @experimental
* @param startNode - The node to start the search (inclusive), defaults to the root node.
* @param endNode - The node to end the search (inclusive), defaults to all descendants of startNode.
* Like {@link $dfs}, reaching endNode stops the traversal before visiting any of its
* children — including its slot subtrees. An endNode strictly inside a slot subtree
* is never reached (slot subtrees are spliced in whole), so it does not truncate
* the traversal.
* @returns An array of DFSNodes. It will always return at least 1 node (the start node).
*/
function $dfsWithSlots(startNode, endNode) {
	return Array.from($dfsWithSlotsIterator(startNode, endNode));
}
/**
* Slot-aware {@link $dfsIterator}: a host's slot subtrees are emitted
* slots-first, right after the host node and before its linked-list children.
* The caret iterator drives the linked-list spine untouched.
* @experimental
* @param startNode - The node to start the search (inclusive), defaults to the root node.
* @param endNode - The node to end the search (inclusive), defaults to all descendants of startNode.
* Like {@link $dfs}, reaching endNode stops the traversal before visiting any of its
* children — including its slot subtrees. An endNode strictly inside a slot subtree
* is never reached (slot subtrees are spliced in whole), so it does not truncate
* the traversal.
* @returns An iterator, each yielded value is a DFSNode. It will always return at least 1 node (the start node).
*/
function* $dfsWithSlotsIterator(startNode, endNode) {
	for (const dfsNode of $dfsCaretIterator("next", startNode, endNode)) {
		yield dfsNode;
		const { node, depth } = dfsNode;
		if ($isSlotHost(node) && !node.is(endNode)) for (const name of $getSlotNames(node)) {
			const slot = $getSlot(node, name);
			if (slot !== null) yield* $dfsSubtreeIterator(slot, depth + 1);
		}
	}
}
/**
* Slots-first preorder traversal of a self-contained subtree (a slot node and
* everything it owns). Used to splice slot subtrees into $dfsWithSlotsIterator.
*/
function* $dfsSubtreeIterator(node, depth) {
	yield {
		depth,
		node
	};
	const childDepth = depth + 1;
	if ($isSlotHost(node)) for (const name of $getSlotNames(node)) {
		const slot = $getSlot(node, name);
		if (slot !== null) yield* $dfsSubtreeIterator(slot, childDepth);
	}
	if ($isElementNode(node)) for (const child of node.getChildren()) yield* $dfsSubtreeIterator(child, childDepth);
}
function $getEndCaret(startNode, direction) {
	const rval = $getAdjacentSiblingOrParentSiblingCaret($getSiblingCaret(startNode, direction));
	return rval && rval[0];
}
function $dfsCaretIterator(direction, startNode, endNode) {
	const root = $getRoot();
	const start = startNode || root;
	const startCaret = $isElementNode(start) ? $getChildCaret(start, direction) : $getSiblingCaret(start, direction);
	const startDepth = $getDepth(start);
	const endCaret = endNode ? $getAdjacentChildCaret($getChildCaretOrSelf($getSiblingCaret(endNode, direction))) || $getEndCaret(endNode, direction) : $getEndCaret(start, direction);
	let depth = startDepth;
	return makeStepwiseIterator({
		hasNext: (state) => state !== null,
		initial: startCaret,
		map: (state) => ({
			depth,
			node: state.origin
		}),
		step: (state) => {
			if (state.isSameNodeCaret(endCaret)) return null;
			if ($isChildCaret(state)) depth++;
			const rval = $getAdjacentSiblingOrParentSiblingCaret(state);
			if (!rval || rval[0].isSameNodeCaret(endCaret)) return null;
			depth += rval[1];
			return rval[0];
		}
	});
}
function $getDepth(node) {
	let depth = -1;
	for (let innerNode = node; innerNode !== null; innerNode = innerNode.getParent() ?? $getSlotHost(innerNode)) depth++;
	return depth;
}
/**
* Performs a right-to-left preorder tree traversal.
* From the starting node it goes to the rightmost child, than backtracks to parent and finds new rightmost path.
* It will return the next node in traversal sequence after the startingNode.
* The traversal is similar to $dfs functions above, but the nodes are visited right-to-left, not left-to-right.
* @param startingNode - The node to start the search.
* @returns The next node in pre-order right to left traversal sequence or `null`, if the node does not exist
*/
function $getNextRightPreorderNode(startingNode) {
	const next = $getAdjacentSiblingOrParentSiblingCaret($getChildCaretOrSelf($getSiblingCaret(startingNode, "previous")), "root");
	return next && next[0].origin;
}
/**
* Takes a node and traverses up its ancestors (toward the root node)
* in order to find a specific type of node.
* @param node - the node to begin searching.
* @param klass - an instance of the type of node to look for.
* @returns the node of type klass that was passed, or null if none exist.
*/
function $getNearestNodeOfType(node, klass) {
	let parent = node;
	while (parent != null) {
		if (parent instanceof klass) return parent;
		parent = parent.getParent();
	}
	return null;
}
/**
* Returns the element node of the nearest ancestor, otherwise throws an error.
* @param startNode - The starting node of the search
* @returns The ancestor node found
*/
function $getNearestBlockElementAncestorOrThrow(startNode) {
	const blockNode = $findMatchingParent(startNode, (node) => $isElementNode(node) && !node.isInline());
	if (!$isElementNode(blockNode)) formatDevErrorMessage$1(`Expected node ${startNode.__key} to have closest block element node.`);
	return blockNode;
}
/**
* Checks whether the selection covers the entire block: the selection's
* start point is at or before the first position inside blockNode and its
* end point is at or after the last position inside blockNode. A selection
* that extends beyond the block's boundaries still fully selects the block,
* and an empty block is fully selected by any selection that touches or
* surrounds it.
*
* @param blockNode - The ElementNode to check, typically a top-level block or the RootNode
* @param selectionOrRange - The RangeSelection or CaretRange to check
* @returns true if the selection covers the entire blockNode
*/
function $isBlockFullySelected(blockNode, selectionOrRange) {
	const range = $getCaretRangeInDirection($isRangeSelection(selectionOrRange) ? $caretRangeFromSelection(selectionOrRange) : selectionOrRange, "next");
	const anchorFrame = $getSlotFrame(range.anchor.origin);
	const blockFrame = $getSlotFrame(blockNode.getLatest());
	if (anchorFrame === null ? blockFrame !== null : !anchorFrame.is(blockFrame)) return false;
	const blockStart = $normalizeCaret($getChildCaret(blockNode, "next"));
	const blockEnd = $getCaretInDirection($normalizeCaret($getChildCaret(blockNode, "previous")), "next");
	return $comparePointCaretNext(range.anchor, blockStart) <= 0 && $comparePointCaretNext(range.focus, blockEnd) >= 0;
}
/**
* Attempts to resolve nested element nodes of the same type into a single node of that type.
* It is generally used for marks/commenting
* @param editor - The lexical editor
* @param targetNode - The target for the nested element to be extracted from.
* @param cloneNode - See {@link $createMarkNode}
* @param handleOverlap - Handles any overlap between the node to extract and the targetNode
* @returns The lexical editor
*/
function registerNestedElementResolver(editor, targetNode, cloneNode, handleOverlap) {
	const $isTargetNode = (node) => {
		return node instanceof targetNode;
	};
	const $findMatch = (node) => {
		const children = node.getChildren();
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if ($isTargetNode(child)) return null;
		}
		let parentNode = node;
		let childNode = node;
		while (parentNode !== null) {
			childNode = parentNode;
			parentNode = parentNode.getParent();
			if ($isTargetNode(parentNode)) return {
				child: childNode,
				parent: parentNode
			};
		}
		return null;
	};
	const $elementNodeTransform = (node) => {
		const match = $findMatch(node);
		if (match !== null) {
			const { child, parent } = match;
			if (child.is(node)) {
				handleOverlap(parent, node);
				const nextSiblings = child.getNextSiblings();
				const nextSiblingsLength = nextSiblings.length;
				parent.insertAfter(child);
				if (nextSiblingsLength !== 0) {
					const newParent = cloneNode(parent);
					child.insertAfter(newParent);
					for (let i = 0; i < nextSiblingsLength; i++) newParent.append(nextSiblings[i]);
				}
				if (!parent.canBeEmpty() && parent.getChildrenSize() === 0) parent.remove();
			}
		}
	};
	return editor.registerNodeTransform(targetNode, $elementNodeTransform);
}
/**
* Clones the editor and marks it as dirty to be reconciled. If there was a selection,
* it would be set back to its previous state, or null otherwise.
* @param editor - The lexical editor
* @param editorState - The editor's state
*/
function $restoreEditorState(editor, editorState) {
	const nodeMap = /* @__PURE__ */ new Map();
	const activeEditorState = editor._pendingEditorState;
	for (const [key, node] of editorState._nodeMap) nodeMap.set(key, $cloneWithProperties(node));
	if (activeEditorState) activeEditorState._nodeMap = nodeMap;
	$fullReconcile();
	const selection = editorState._selection;
	$setSelection(selection === null ? null : selection.clone());
}
/**
* If the selected insertion area is the root/shadow root node (see {@link lexical!$isRootOrShadowRoot}),
* the node will be appended there, otherwise, it will be inserted before the insertion area.
* If there is no selection where the node is to be inserted, it will be appended after any current nodes
* within the tree, as a child of the root node. A paragraph will then be added after the inserted node and selected.
* @param node - The node to be inserted
* @returns The node after its insertion
*/
function $insertNodeToNearestRoot(node) {
	const selection = $getSelection() || $getPreviousSelection();
	let initialCaret;
	if ($isRangeSelection(selection)) initialCaret = $caretFromPoint(selection.focus, "next");
	else {
		if (selection != null) {
			const nodes = selection.getNodes();
			const lastNode = nodes[nodes.length - 1];
			if (lastNode) initialCaret = $getSiblingCaret(lastNode, "next");
		}
		initialCaret = initialCaret || $getChildCaret($getRoot(), "previous").getFlipped().insert($createParagraphNode());
	}
	const insertCaret = $insertNodeToNearestRootAtCaret(node, initialCaret);
	const adjacent = $getAdjacentChildCaret(insertCaret);
	$setSelectionFromCaretRange($getCollapsedCaretRange($isChildCaret(adjacent) ? $normalizeCaret(adjacent) : insertCaret));
	return node.getLatest();
}
/**
* Inserts a node into leaf — the deepest accessible node at the carriage position
* @param node - The node to be inserted
*/
function $insertNodeIntoLeaf(node) {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) {
		if (selection) selection.insertNodes([node]);
		return;
	}
	let insertCaret = $getCaretRangeInDirection($removeTextFromCaretRange($caretRangeFromSelection(selection)), "next").anchor;
	if ($isTextPointCaret(insertCaret)) {
		const nextAnchor = $splitAtPointCaretNext(insertCaret);
		if (!nextAnchor) return;
		insertCaret = nextAnchor;
	}
	const focus = insertCaret.getFlipped();
	focus.insert(node);
	$setSelectionFromCaretRange($getCaretRange(focus, focus));
}
/**
* Wraps the node into another node created from a createElementNode function, eg. $createParagraphNode
* @param node - Node to be wrapped.
* @param createElementNode - Creates a new lexical element to wrap the to-be-wrapped node and returns it.
* @returns A new lexical element with the previous node appended within (as a child, including its children).
*/
function $wrapNodeInElement(node, createElementNode) {
	const elementNode = createElementNode();
	node.replace(elementNode);
	elementNode.append(node);
	return elementNode;
}
/**
* @param object = The instance of the type
* @param objectClass = The class of the type
* @returns Whether the object is has the same Klass of the objectClass, ignoring the difference across window (e.g. different iframes)
*/
function objectKlassEquals(object, objectClass) {
	return object !== null ? Object.getPrototypeOf(object).constructor.name === objectClass.name : false;
}
function eventFiles(event) {
	let dataTransfer = null;
	if (objectKlassEquals(event, DragEvent)) dataTransfer = event.dataTransfer;
	else if (objectKlassEquals(event, ClipboardEvent)) dataTransfer = event.clipboardData;
	if (dataTransfer === null) return [
		false,
		[],
		false
	];
	const types = dataTransfer.types;
	const hasFiles = types.includes("Files");
	const hasContent = types.includes("text/html") || types.includes("text/plain");
	return [
		hasFiles,
		Array.from(dataTransfer.files),
		hasContent
	];
}
/**
* Applies the provided callback to each indentable block element in the Selection
*
* @param indentOrOutdent callback for performing the indent or outdent action
* on a given block element.
* @returns true if at least one block was handled, false otherwise.
*/
function $handleIndentAndOutdent(indentOrOutdent) {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return false;
	const alreadyHandled = /* @__PURE__ */ new Set();
	const nodes = selection.getNodes();
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const key = node.getKey();
		if (alreadyHandled.has(key)) continue;
		const parentBlock = $findMatchingParent(node, (parentNode) => $isElementNode(parentNode) && !parentNode.isInline());
		if (parentBlock === null) continue;
		const parentKey = parentBlock.getKey();
		if (parentBlock.canIndent() && !alreadyHandled.has(parentKey)) {
			alreadyHandled.add(parentKey);
			indentOrOutdent(parentBlock);
		}
	}
	return alreadyHandled.size > 0;
}
/**
* Appends the node before the first child of the parent node
* @param parent A parent node
* @param node Node that needs to be appended
*/
function $insertFirst(parent, node) {
	$getChildCaret(parent, "next").insert(node);
}
var NEEDS_MANUAL_ZOOM = IS_FIREFOX || !CAN_USE_DOM ? false : void 0;
function needsManualZoom() {
	if (NEEDS_MANUAL_ZOOM === void 0) {
		const div = document.createElement("div");
		div.style.position = "absolute";
		div.style.opacity = "0";
		div.style.width = "100px";
		div.style.left = "-1000px";
		document.body.appendChild(div);
		const noZoom = div.getBoundingClientRect();
		div.style.setProperty("zoom", "2");
		NEEDS_MANUAL_ZOOM = div.getBoundingClientRect().width === noZoom.width;
		document.body.removeChild(div);
	}
	return NEEDS_MANUAL_ZOOM;
}
/**
* Calculates the zoom level of an element as a result of using
* css zoom property. For browsers that implement standardized CSS
* zoom (Firefox, Chrome >= 128), this will always return 1.
* @param element
* @param useManualZoom - If true, always use zoom level will be calculated manually, otherwise it will be calculated on as needed basis.
*/
function calculateZoomLevel(element, useManualZoom = false) {
	let zoom = 1;
	if (needsManualZoom() || useManualZoom) {
		const win = element && element.ownerDocument.defaultView || window;
		while (element) {
			zoom *= Number(win.getComputedStyle(element).getPropertyValue("zoom"));
			element = getParentElement(element);
		}
	}
	return zoom;
}
/**
* Checks if the editor is a nested editor created by LexicalNestedComposer
*/
function $isEditorIsNestedEditor(editor) {
	return editor._parentEditor !== null;
}
/**
* A depth first last-to-first traversal of root that stops at each node that matches
* $predicate and ensures that its parent is root. This is typically used to discard
* invalid or unsupported wrapping nodes. For example, a TableNode must only have
* TableRowNode as children, but an importer might add invalid nodes based on
* caption, tbody, thead, etc. and this will unwrap and discard those.
*
* @param root The root to start the traversal
* @param $predicate Should return true for nodes that are permitted to be children of root
* @returns true if this unwrapped or removed any nodes
*/
function $unwrapAndFilterDescendants(root, $predicate) {
	return $unwrapAndFilterDescendantsImpl(root, $predicate, null);
}
function $unwrapAndFilterDescendantsImpl(root, $predicate, $onSuccess) {
	let didMutate = false;
	for (const node of $lastToFirstIterator(root)) {
		if ($predicate(node)) {
			if ($onSuccess !== null) $onSuccess(node);
			continue;
		}
		didMutate = true;
		if ($isElementNode(node)) $unwrapAndFilterDescendantsImpl(node, $predicate, $onSuccess || ((child) => node.insertAfter(child)));
		node.remove();
	}
	return didMutate;
}
/**
* A depth first traversal of the children array that stops at and collects
* each node that `$predicate` matches. This is typically used to discard
* invalid or unsupported wrapping nodes on a children array in the `after`
* of an {@link lexical!DOMConversionOutput}. For example, a TableNode must only have
* TableRowNode as children, but an importer might add invalid nodes based on
* caption, tbody, thead, etc. and this will unwrap and discard those.
*
* This function is read-only and performs no mutation operations, which makes
* it suitable for import and export purposes but likely not for any in-place
* mutation. You should use {@link $unwrapAndFilterDescendants} for in-place
* mutations such as node transforms.
*
* @param children The children to traverse
* @param $predicate Should return true for nodes that are permitted to be children of root
* @returns The children or their descendants that match $predicate
*/
function $descendantsMatching(children, $predicate) {
	const result = [];
	const stack = Array.from(children).reverse();
	for (let child = stack.pop(); child !== void 0; child = stack.pop()) if ($predicate(child)) result.push(child);
	else if ($isElementNode(child)) for (const grandchild of $lastToFirstIterator(child)) stack.push(grandchild);
	return result;
}
/**
* Return an iterator that yields each child of node from last to first, taking
* care to preserve the previous sibling before yielding the value in case the caller
* removes the yielded node.
*
* @param node The node whose children to iterate
* @returns An iterator of the node's children
*/
function $lastToFirstIterator(node) {
	return $childIterator($getChildCaret(node, "previous"));
}
function $childIterator(startCaret) {
	const seen = /* @__PURE__ */ new Set();
	return makeStepwiseIterator({
		hasNext: $isSiblingCaret,
		initial: startCaret.getAdjacentCaret(),
		map: (caret) => {
			const origin = caret.origin.getLatest();
			if (seen !== null) {
				const key = origin.getKey();
				if (!!seen.has(key)) formatDevErrorMessage$1(`$childIterator: Cycle detected, node with key ${String(key)} has already been traversed`);
				seen.add(key);
			}
			return origin;
		},
		step: (caret) => caret.getAdjacentCaret()
	});
}
/**
* Replace this node with its children
*
* @param node The ElementNode to unwrap and remove
*/
function $unwrapNode(node) {
	$rewindSiblingCaret($getSiblingCaret(node, "next")).splice(1, node.getChildren());
}
/**
* Inserts a new paragraph before a container node when the cursor moves outside the container element
*
* Intended for use ArrowLeft/ArrowUp keyboard handlers to allow the user to break out
* of a container node by creating a new paragraph before it.
*
* A paragraph is inserted if that the cursor is positioned at the beginning inside the container,
* and the container itself is the first element in the document and has no preceding sibling
*
* When a paragraph is inserted the selection is moved to it and, if the
* triggering keyboard event is provided, its default action is prevented so
* the browser does not additionally move the selection. Relying on the native
* caret movement is not portable: Chromium moves into the freshly inserted
* paragraph while Firefox leaves the caret inside the container.
*
* @param $isContainerNode - Type guard identifying the container node type to escape from.
* @param event - The keyboard event that triggered the escape, if any. Its
*   default action is prevented when a paragraph is inserted.
* @returns `true` if a paragraph was inserted, `false` otherwise.
*/
function $onEscapeUp($isContainerNode, event) {
	const selection = $getSelection();
	if ($isRangeSelection(selection) && selection.isCollapsed()) {
		const containerNode = $findMatchingParent(selection.anchor.getNode(), $isContainerNode);
		if (containerNode) {
			const parent = containerNode.getParent();
			if (parent !== null && parent.getFirstChild() === containerNode && $isAtStartOfNode(selection.anchor, containerNode)) {
				containerNode.insertBefore($createParagraphNode()).selectEnd();
				if (event) event.preventDefault();
				return true;
			}
		}
	}
	return false;
}
/**
* Inserts a new paragraph after a container node when the cursor moves outside the container element
*
* Intended for use ArrowRight/ArrowDown keyboard handlers to allow the user to break out
* of a container node by creating a new paragraph after it.
*
* A paragraph is inserted if that the cursor is positioned at the ending inside the container,
* and the container itself is the last element in the document and has no next sibling
*
* When a paragraph is inserted the selection is moved to it and, if the
* triggering keyboard event is provided, its default action is prevented so
* the browser does not additionally move the selection. Relying on the native
* caret movement is not portable: Chromium moves into the freshly inserted
* paragraph while Firefox leaves the caret inside the container.
*
* @param $isContainerNode - Type guard identifying the container node type to escape from.
* @param event - The keyboard event that triggered the escape, if any. Its
*   default action is prevented when a paragraph is inserted.
* @returns `true` if a paragraph was inserted, `false` otherwise.
*/
function $onEscapeDown($isContainerNode, event) {
	const selection = $getSelection();
	if ($isRangeSelection(selection) && selection.isCollapsed()) {
		const containerNode = $findMatchingParent(selection.anchor.getNode(), $isContainerNode);
		if (containerNode) {
			const parent = containerNode.getParent();
			if (parent !== null && parent.getLastChild() === containerNode && $isAtEndOfNode(selection.anchor, containerNode)) {
				containerNode.insertAfter($createParagraphNode()).selectEnd();
				if (event) event.preventDefault();
				return true;
			}
		}
	}
	return false;
}
/**
* Whether the collapsed `point` sits at the very start of `node`'s content —
* on its first descendant (or on the empty node itself) at offset 0. Shared by
* {@link $onEscapeUp} and slot-aware variants so the "at the leading edge of a
* container" test stays in one place.
*/
function $isAtStartOfNode(point, node) {
	return $isAtEdgeOfElement(point, node, "previous");
}
/**
* Whether the collapsed `point` sits at the very end of `node`'s content — on
* its last descendant (or on the empty node itself) at that node's end. Shared
* by {@link $onEscapeDown} and slot-aware variants so the "at the trailing edge
* of a container" test stays in one place.
*/
function $isAtEndOfNode(point, node) {
	return $isAtEdgeOfElement(point, node, "next");
}
//#endregion
//#region ../lexical-extension/dist/LexicalExtension.dev.mjs
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
var i = Symbol.for("preact-signals");
function t() {
	if (e > 1) {
		e--;
		return;
	}
	let i, t = false;
	(function() {
		let i = r;
		r = void 0;
		while (void 0 !== i) {
			if (i.S.v === i.v) i.S.i = i.i;
			i = i.o;
		}
	})();
	while (void 0 !== s) {
		let n = s;
		s = void 0;
		u++;
		while (void 0 !== n) {
			const o = n.u;
			n.u = void 0;
			n.f &= -3;
			if (!(8 & n.f) && w(n)) try {
				n.c();
			} catch (n) {
				if (!t) {
					i = n;
					t = true;
				}
			}
			n = o;
		}
	}
	u = 0;
	e--;
	if (t) throw i;
}
function n(i) {
	if (e > 0) return i();
	d = ++c;
	e++;
	try {
		return i();
	} finally {
		t();
	}
}
var o, s;
function h(i) {
	const t = o;
	o = void 0;
	try {
		return i();
	} finally {
		o = t;
	}
}
var r, e = 0, u = 0, c = 0, d = 0, v = 0;
function l(i) {
	if (void 0 === o) return;
	let t = i.n;
	if (void 0 === t || t.t !== o) {
		t = {
			i: 0,
			S: i,
			p: o.s,
			n: void 0,
			t: o,
			e: void 0,
			x: void 0,
			r: t
		};
		if (void 0 !== o.s) o.s.n = t;
		o.s = t;
		i.n = t;
		if (32 & o.f) i.S(t);
		return t;
	} else if (-1 === t.i) {
		t.i = 0;
		if (void 0 !== t.n) {
			t.n.p = t.p;
			if (void 0 !== t.p) t.p.n = t.n;
			t.p = o.s;
			t.n = void 0;
			o.s.n = t;
			o.s = t;
		}
		return t;
	}
}
function y(i, t) {
	this.v = i;
	this.i = 0;
	this.n = void 0;
	this.t = void 0;
	this.l = 0;
	this.W = null == t ? void 0 : t.watched;
	this.Z = null == t ? void 0 : t.unwatched;
	this.name = null == t ? void 0 : t.name;
}
y.prototype.brand = i;
y.prototype.h = function() {
	return true;
};
y.prototype.S = function(i) {
	const t = this.t;
	if (t !== i && void 0 === i.e) {
		i.x = t;
		this.t = i;
		if (void 0 !== t) t.e = i;
		else h(() => {
			var i;
			null == (i = this.W) || i.call(this);
		});
	}
};
y.prototype.U = function(i) {
	if (void 0 !== this.t) {
		const t = i.e, n = i.x;
		if (void 0 !== t) {
			t.x = n;
			i.e = void 0;
		}
		if (void 0 !== n) {
			n.e = t;
			i.x = void 0;
		}
		if (i === this.t) {
			this.t = n;
			if (void 0 === n) h(() => {
				var i;
				null == (i = this.Z) || i.call(this);
			});
		}
	}
};
y.prototype.subscribe = function(i) {
	return j(() => {
		const t = this.value, n = o;
		o = void 0;
		try {
			i(t);
		} finally {
			o = n;
		}
	}, { name: "sub" });
};
y.prototype.valueOf = function() {
	return this.value;
};
y.prototype.toString = function() {
	return this.value + "";
};
y.prototype.toJSON = function() {
	return this.value;
};
y.prototype.peek = function() {
	const i = o;
	o = void 0;
	try {
		return this.value;
	} finally {
		o = i;
	}
};
Object.defineProperty(y.prototype, "value", {
	get() {
		const i = l(this);
		if (void 0 !== i) i.i = this.i;
		return this.v;
	},
	set(i) {
		if (i !== this.v) {
			if (u > 100) throw new Error("Cycle detected");
			(function(i) {
				if (0 !== e && 0 === u) {
					if (i.l !== d) {
						i.l = d;
						r = {
							S: i,
							v: i.v,
							i: i.i,
							o: r
						};
					}
				}
			})(this);
			this.v = i;
			this.i++;
			v++;
			e++;
			try {
				for (let i = this.t; void 0 !== i; i = i.x) i.t.N();
			} finally {
				t();
			}
		}
	}
});
function a(i, t) {
	return new y(i, t);
}
function w(i) {
	for (let t = i.s; void 0 !== t; t = t.n) if (t.S.i !== t.i || !t.S.h() || t.S.i !== t.i) return true;
	return false;
}
function _(i) {
	for (let t = i.s; void 0 !== t; t = t.n) {
		const n = t.S.n;
		if (void 0 !== n) t.r = n;
		t.S.n = t;
		t.i = -1;
		if (void 0 === t.n) {
			i.s = t;
			break;
		}
	}
}
function b(i) {
	let t, n = i.s;
	while (void 0 !== n) {
		const i = n.p;
		if (-1 === n.i) {
			n.S.U(n);
			if (void 0 !== i) i.n = n.n;
			if (void 0 !== n.n) n.n.p = i;
		} else t = n;
		n.S.n = n.r;
		if (void 0 !== n.r) n.r = void 0;
		n = i;
	}
	i.s = t;
}
function p(i, t) {
	y.call(this, void 0);
	this.x = i;
	this.s = void 0;
	this.g = v - 1;
	this.f = 4;
	this.W = null == t ? void 0 : t.watched;
	this.Z = null == t ? void 0 : t.unwatched;
	this.name = null == t ? void 0 : t.name;
}
p.prototype = new y();
p.prototype.h = function() {
	this.f &= -3;
	if (1 & this.f) return false;
	if (32 == (36 & this.f)) return true;
	this.f &= -5;
	if (this.g === v) return true;
	this.g = v;
	this.f |= 1;
	if (this.i > 0 && !w(this)) {
		this.f &= -2;
		return true;
	}
	const i = o;
	try {
		_(this);
		o = this;
		const i = this.x();
		if (16 & this.f || this.v !== i || 0 === this.i) {
			this.v = i;
			this.f &= -17;
			this.i++;
		}
	} catch (i) {
		this.v = i;
		this.f |= 16;
		this.i++;
	}
	o = i;
	b(this);
	this.f &= -2;
	return true;
};
p.prototype.S = function(i) {
	if (void 0 === this.t) {
		this.f |= 36;
		for (let i = this.s; void 0 !== i; i = i.n) i.S.S(i);
	}
	y.prototype.S.call(this, i);
};
p.prototype.U = function(i) {
	if (void 0 !== this.t) {
		y.prototype.U.call(this, i);
		if (void 0 === this.t) {
			this.f &= -33;
			for (let i = this.s; void 0 !== i; i = i.n) i.S.U(i);
		}
	}
};
p.prototype.N = function() {
	if (!(2 & this.f)) {
		this.f |= 6;
		for (let i = this.t; void 0 !== i; i = i.x) i.t.N();
	}
};
Object.defineProperty(p.prototype, "value", { get() {
	if (1 & this.f) throw new Error("Cycle detected");
	const i = l(this);
	this.h();
	if (void 0 !== i) i.i = this.i;
	if (16 & this.f) throw this.v;
	return this.v;
} });
function g(i, t) {
	return new p(i, t);
}
function S(i) {
	const n = i.m;
	i.m = void 0;
	if ("function" == typeof n) {
		e++;
		const s = o;
		o = void 0;
		try {
			n();
		} catch (t) {
			i.f &= -2;
			i.f |= 8;
			m(i);
			throw t;
		} finally {
			o = s;
			t();
		}
	}
}
function m(i) {
	for (let t = i.s; void 0 !== t; t = t.n) t.S.U(t);
	i.x = void 0;
	i.s = void 0;
	S(i);
}
function x(i) {
	if (o !== this) throw new Error("Out-of-order effect");
	b(this);
	o = i;
	this.f &= -2;
	if (8 & this.f) m(this);
	t();
}
function E(i, t) {
	this.x = i;
	this.m = void 0;
	this.s = void 0;
	this.u = void 0;
	this.f = 32;
	this.name = null == t ? void 0 : t.name;
}
E.prototype.c = function() {
	const i = this.S();
	try {
		if (8 & this.f) return;
		if (void 0 === this.x) return;
		const t = this.x();
		if ("function" == typeof t) this.m = t;
	} finally {
		i();
	}
};
E.prototype.S = function() {
	if (1 & this.f) throw new Error("Cycle detected");
	this.f |= 1;
	this.f &= -9;
	S(this);
	_(this);
	e++;
	const i = o;
	o = this;
	return x.bind(this, i);
};
E.prototype.N = function() {
	if (!(2 & this.f)) {
		this.f |= 2;
		this.u = s;
		s = this;
	}
};
E.prototype.d = function() {
	this.f |= 8;
	if (!(1 & this.f)) m(this);
};
E.prototype.dispose = function() {
	this.d();
};
function j(i, t) {
	const n = new E(i, t);
	try {
		n.c();
	} catch (i) {
		n.d();
		throw i;
	}
	const o = n.d.bind(n);
	o[Symbol.dispose] = o;
	return o;
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Return an object with the same shape as `defaults` with a {@link Signal}
* for each value. If specified, the second `opts` argument is a partial
* of overrides to the defaults and will be used as the initial value.
*
* Typically used to make a reactive version of some subset of the
* configuration of an extension, so it can be reconfigured at runtime.
*
* @param defaults The object with default values
* @param opts Overrides to those default values
* @returns An object with signals initialized with the default values
*/
function namedSignals(defaults, opts = {}) {
	const initial = {};
	for (const k in defaults) {
		const v = opts[k];
		initial[k] = a(v === void 0 ? defaults[k] : v);
	}
	return initial;
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* An Extension to focus the LexicalEditor when the root element is set
* (typically only when the editor is first created).
*/
var AutoFocusExtension = /* @__PURE__ */ defineExtension({
	build: (editor, config, state) => {
		return namedSignals(config);
	},
	config: /* @__PURE__ */ safeCast({
		defaultSelection: "rootEnd",
		disabled: false
	}),
	name: "@lexical/extension/AutoFocus",
	register(editor, config, state) {
		const stores = state.getOutput();
		return j(() => stores.disabled.value ? void 0 : editor.registerRootListener((rootElement) => {
			editor.focus(() => {
				const activeElement = rootElement !== null ? getActiveElement(rootElement) : null;
				if (rootElement !== null && (activeElement === null || !rootElement.contains(activeElement))) rootElement.focus({ preventScroll: true });
			}, { defaultSelection: stores.defaultSelection.peek() });
		}));
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function $defaultOnClear() {
	const root = $getRoot();
	const selection = $getSelection();
	const paragraph = $createParagraphNode();
	root.clear();
	root.append(paragraph);
	if (selection !== null) paragraph.select();
	if ($isRangeSelection(selection)) selection.format = 0;
}
function registerClearEditor(editor, $onClear = $defaultOnClear) {
	return editor.registerCommand(CLEAR_EDITOR_COMMAND, () => {
		$onClear();
		return true;
	}, 0);
}
/**
* An extension to provide an implementation of {@link CLEAR_EDITOR_COMMAND}
*/
var ClearEditorExtension = /* @__PURE__ */ defineExtension({
	build(editor, config, state) {
		return namedSignals(config);
	},
	config: /* @__PURE__ */ safeCast({ $onClear: $defaultOnClear }),
	name: "@lexical/extension/ClearEditor",
	register(editor, config, state) {
		const { $onClear } = state.getOutput();
		return j(() => registerClearEditor(editor, $onClear.value));
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* @experimental
*
* Default predicate matches {@link DecoratorNode} and shadow-root
* `ElementNode`s (e.g. `TableNode`). Apps that want to also trigger on
* other node types — `CodeNode`, custom non-editable blocks — should
* compose this default in their own predicate rather than re-deriving
* the check:
*
* ```ts
* configExtension(ClickAfterLastBlockExtension, {
*   $shouldInsertAfter: (node) =>
*     $defaultShouldInsertAfter(node) || $isCodeNode(node),
* });
* ```
*/
function $defaultShouldInsertAfter(node) {
	if ($isDecoratorNode(node)) return true;
	if ($isElementNode(node) && node.isShadowRoot()) return true;
	return false;
}
/**
* Decide whether a click at `event` should be claimed by this extension.
* Used by both the mousedown listener (to call preventDefault on the
* browser's native caret pick) and the click listener (to actually
* insert the paragraph). Factored out so the two handlers stay in sync
* — they would otherwise share ~22 lines of byte-for-byte identical
* logic and have to be maintained together.
*
* Read-only because it is called outside an editor.update; mutation
* happens in the click handler's editor.update below.
*/
function shouldClaimClick(editor, rootElement, event, $shouldInsertAfter) {
	if (!editor.isEditable()) return false;
	if (event.target !== rootElement) return false;
	return editor.read("latest", () => {
		const lastChild = $getRoot().getLastChild();
		if (lastChild === null) return false;
		const lastChildDOM = editor.getElementByKey(lastChild.getKey());
		if (lastChildDOM === null) return false;
		if (event.clientY <= lastChildDOM.getBoundingClientRect().bottom) return false;
		return $shouldInsertAfter(lastChild);
	});
}
/**
* Click handling for the empty area below the last block of the document.
*
* Without this extension, clicking the area below the last block when that
* block is a {@link DecoratorNode}, a shadow-root ElementNode (e.g.
* `TableNode`), or any other block that doesn't accept the click naturally
* leaves the selection in an awkward place — `null` for a bare decorator,
* or at the end of a table cell. Users typically expect a new paragraph
* to appear below the block with the caret in it, matching the behavior
* of editors like Notion.
*
* This extension intercepts clicks under those conditions, inserts a new
* empty paragraph after the last block, and selects it.
*
* Closes #8544.
*/
var ClickAfterLastBlockExtension = /* @__PURE__ */ defineExtension({
	build: (_editor, config) => namedSignals(config),
	config: /* @__PURE__ */ safeCast({
		$shouldInsertAfter: $defaultShouldInsertAfter,
		disabled: false
	}),
	name: "@lexical/ClickAfterLastBlock",
	register: (editor, _config, _state) => j(() => {
		const output = _state.getOutput();
		if (output.disabled.value) return;
		return editor.registerRootListener((rootElement) => {
			if (rootElement === null) return;
			const onMouseDown = (event) => {
				if (shouldClaimClick(editor, rootElement, event, output.$shouldInsertAfter.peek())) event.preventDefault();
			};
			const onClick = (event) => {
				if (!shouldClaimClick(editor, rootElement, event, output.$shouldInsertAfter.peek())) return;
				event.preventDefault();
				stopLexicalPropagation(event);
				editor.update(() => {
					const lastChild = $getRoot().getLastChild();
					if (lastChild === null) return;
					if (!output.$shouldInsertAfter.peek()(lastChild)) return;
					const paragraph = $createParagraphNode();
					lastChild.insertAfter(paragraph);
					paragraph.select();
				});
			};
			return registerEventListeners(rootElement, {
				click: onClick,
				mousedown: onMouseDown
			}, true);
		});
	})
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Get the sets of nodes and types registered in the
* {@link InitialEditorConfig}. This is to be used when an extension
* needs to register optional behavior if some node or type is present.
*
* @param config The InitialEditorConfig (accessible from an extension's init)
* @returns The known types and nodes as Sets
*/
function getKnownTypesAndNodes(config) {
	const types = /* @__PURE__ */ new Set();
	const nodes = /* @__PURE__ */ new Set();
	for (const klassOrReplacement of getNodeConfig(config)) {
		const klass = typeof klassOrReplacement === "function" ? klassOrReplacement : klassOrReplacement.replace;
		getStaticNodeConfig(klass);
		types.add(klass.getType());
		nodes.add(klass);
	}
	return {
		nodes,
		types
	};
}
function getNodeConfig(config) {
	return (typeof config.nodes === "function" ? config.nodes() : config.nodes) || [];
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
var formatState = /* @__PURE__ */ createState("format", { parse: (value) => typeof value === "number" ? value : 0 });
var DecoratorTextNode = class extends DecoratorNode {
	/** @internal */
	get __isInlineFormattable() {
		return true;
	}
	$config() {
		return this.config("decorator-text", {
			extends: DecoratorNode,
			stateConfigs: [{
				flat: true,
				stateConfig: formatState
			}]
		});
	}
	getFormat(version) {
		return $getState(this, formatState, version);
	}
	getFormatFlags(type, alignWithFormat) {
		return toggleTextFormatType(this.getFormat(), type, alignWithFormat);
	}
	hasFormat(type) {
		const formatFlag = TEXT_TYPE_TO_FORMAT[type];
		return (this.getFormat() & formatFlag) !== 0;
	}
	setFormat(type) {
		return $setState(this, formatState, type);
	}
	toggleFormat(type) {
		const newFormat = toggleTextFormatType(this.getFormat(), type, null);
		return this.setFormat(newFormat);
	}
	isInline() {
		return true;
	}
	createDOM(config, editor) {
		return $getDocument().createElement("span");
	}
};
/**
* Applies formatting to the node based on the properties in the passed style object.
* By default, properties are checked according to the values set
* when importing content from Google Docs.
* This algorithm is identical to the TextNode import.

* @param lexicalNode The node to which the format will apply
* @param style CSS style object
* @param shouldApply format to apply if it is not in style
* @returns lexicalNode
*/
function applyFormatFromStyle(lexicalNode, style, shouldApply) {
	const fontWeight = style.fontWeight;
	const textDecoration = style.textDecoration.split(" ");
	const hasBoldFontWeight = fontWeight === "700" || fontWeight === "bold";
	const hasLinethroughTextDecoration = textDecoration.includes("line-through");
	const hasItalicFontStyle = style.fontStyle === "italic";
	const hasUnderlineTextDecoration = textDecoration.includes("underline");
	const verticalAlign = style.verticalAlign;
	if (hasBoldFontWeight && !lexicalNode.hasFormat("bold")) lexicalNode.toggleFormat("bold");
	if (hasLinethroughTextDecoration && !lexicalNode.hasFormat("strikethrough")) lexicalNode.toggleFormat("strikethrough");
	if (hasItalicFontStyle && !lexicalNode.hasFormat("italic")) lexicalNode.toggleFormat("italic");
	if (hasUnderlineTextDecoration && !lexicalNode.hasFormat("underline")) lexicalNode.toggleFormat("underline");
	if (verticalAlign === "sub" && !lexicalNode.hasFormat("subscript")) lexicalNode.toggleFormat("subscript");
	if (verticalAlign === "super" && !lexicalNode.hasFormat("superscript")) lexicalNode.toggleFormat("superscript");
	if (shouldApply && !lexicalNode.hasFormat(shouldApply)) lexicalNode.toggleFormat(shouldApply);
	return lexicalNode;
}
/**
* The function wraps the passed DOM node in semantic tags depending on the node format.
*
* @param lexicalNode The node where the format is checked
* @param domNode DOM that will be wrapped in tags
* @param tagNameToFormat Tag name and format mapping
* @returns domNode
*/
function applyFormatToDom(lexicalNode, domNode, tagNameToFormat = DEFAULT_TAG_NAME_TO_FORMAT) {
	let rval = domNode;
	for (const [tag, format] of Object.entries(tagNameToFormat)) if (lexicalNode.hasFormat(format)) rval = wrapElementWith(rval, tag);
	return rval;
}
function wrapElementWith(element, tag) {
	const el = element.ownerDocument.createElement(tag);
	el.appendChild(element);
	return el;
}
var DEFAULT_TAG_NAME_TO_FORMAT = {
	b: "bold",
	code: "code",
	em: "italic",
	i: "italic",
	mark: "highlight",
	s: "strikethrough",
	strong: "bold",
	sub: "subscript",
	sup: "superscript",
	u: "underline"
};
/**
* An extension that registers DecoratorTextNode with the editor.
*/
var DecoratorTextExtension = /* @__PURE__ */ defineExtension({
	name: "@lexical/extension/DecoratorText",
	nodes: () => [DecoratorTextNode]
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Create a Signal that will subscribe to a value from an external store when watched, similar to
* React's [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore).
*
* @param getSnapshot Used to get the initial value of the signal when created and when first watched.
* @param register A callback that will subscribe to some external store and update the signal, must return a dispose function.
* @returns The signal
*/
function watchedSignal(getSnapshot, register) {
	let dispose;
	return a(getSnapshot(), {
		unwatched() {
			if (dispose) {
				dispose();
				dispose = void 0;
			}
		},
		watched() {
			this.value = getSnapshot();
			dispose = register(this);
		}
	});
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* An extension to provide the current EditorState as a signal
*/
var EditorStateExtension = /* @__PURE__ */ defineExtension({
	build(editor) {
		return watchedSignal(() => editor.getEditorState(), (editorStateSignal) => editor.registerUpdateListener((payload) => {
			editorStateSignal.value = payload.editorState;
		}));
	},
	name: "@lexical/extension/EditorState"
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function formatDevErrorMessage(message) {
	throw new Error(message);
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
var envLexicalVersion;
try {
	envLexicalVersion = "0.49.0+dev.esm";
} catch (_unused) {}
var LEXICAL_VERSION = envLexicalVersion ?? "\"<unknown>+source\"";
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Recursively merge the given theme configuration in-place.
*
* @returns If `a` and `b` are both objects (and `b` is not an Array) then
* all keys in `b` are merged into `a` then `a` is returned.
* Otherwise `b` is returned.
*
* @example
* ```ts
* const a = { a: "a", nested: { a: 1 } };
* const b = { b: "b", nested: { b: 2 } };
* const rval = deepThemeMergeInPlace(a, b);
* expect(a).toBe(rval);
* expect(a).toEqual({ a: "a", b: "b", nested: { a: 1, b: 2 } });
* ```
*/
var UNSAFE_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function deepThemeMergeInPlace(a, b) {
	if (a && b && !Array.isArray(b) && typeof a === "object" && typeof b === "object") {
		const aObj = a;
		const bObj = b;
		for (const k in bObj) {
			if (UNSAFE_KEYS.has(k) || !Object.prototype.hasOwnProperty.call(bObj, k)) continue;
			aObj[k] = deepThemeMergeInPlace(aObj[k], bObj[k]);
		}
		return a;
	}
	return b;
}
var ExtensionRepStateIds = {
	unmarked: 0,
	temporary: 1,
	permanent: 2,
	configured: 3,
	initialized: 4,
	built: 5,
	registered: 6,
	afterRegistration: 7
};
function isExactlyUnmarkedExtensionRepState(state) {
	return state.id === ExtensionRepStateIds.unmarked;
}
function isExactlyTemporaryExtensionRepState(state) {
	return state.id === ExtensionRepStateIds.temporary;
}
function isExactlyPermanentExtensionRepState(state) {
	return state.id === ExtensionRepStateIds.permanent;
}
function isConfiguredExtensionRepState(state) {
	return state.id >= ExtensionRepStateIds.configured;
}
function isInitializedExtensionRepState(state) {
	return state.id >= ExtensionRepStateIds.initialized;
}
function isBuiltExtensionRepState(state) {
	return state.id >= ExtensionRepStateIds.built;
}
function isAfterRegistrationState(state) {
	return state.id >= ExtensionRepStateIds.afterRegistration;
}
function applyTemporaryMark(state) {
	if (!isExactlyUnmarkedExtensionRepState(state)) formatDevErrorMessage(`LexicalBuilder: Can not apply a temporary mark from state id ${String(state.id)} (expected ${String(ExtensionRepStateIds.unmarked)} unmarked)`);
	return Object.assign(state, { id: ExtensionRepStateIds.temporary });
}
function applyPermanentMark(state) {
	if (!isExactlyTemporaryExtensionRepState(state)) formatDevErrorMessage(`LexicalBuilder: Can not apply a permanent mark from state id ${String(state.id)} (expected ${String(ExtensionRepStateIds.temporary)} temporary)`);
	return Object.assign(state, { id: ExtensionRepStateIds.permanent });
}
function applyConfiguredState(state, config, registerState) {
	return Object.assign(state, {
		config,
		id: ExtensionRepStateIds.configured,
		registerState
	});
}
function applyInitializedState(state, initResult, registerState) {
	return Object.assign(state, {
		id: ExtensionRepStateIds.initialized,
		initResult,
		registerState
	});
}
function applyBuiltState(state, output, registerState) {
	return Object.assign(state, {
		id: ExtensionRepStateIds.built,
		output,
		registerState
	});
}
function applyRegisteredState(state) {
	return Object.assign(state, { id: ExtensionRepStateIds.registered });
}
function applyAfterRegistrationState(state) {
	return Object.assign(state, { id: ExtensionRepStateIds.afterRegistration });
}
function rollbackToBuiltState(state) {
	return Object.assign(state, { id: ExtensionRepStateIds.built });
}
var emptySet = /* @__PURE__ */ new Set();
/**
* @internal
*/
var ExtensionRep = class {
	builder;
	configs;
	_dependency;
	_peerNameSet;
	extension;
	state;
	_signal;
	constructor(builder, extension) {
		this.builder = builder;
		this.extension = extension;
		this.configs = /* @__PURE__ */ new Set();
		this.state = { id: ExtensionRepStateIds.unmarked };
	}
	mergeConfigs() {
		let config = this.extension.config || {};
		const mergeConfig = this.extension.mergeConfig ? this.extension.mergeConfig.bind(this.extension) : shallowMergeConfig;
		for (const cfg of this.configs) config = mergeConfig(config, cfg);
		return config;
	}
	init(editorConfig) {
		const initialState = this.state;
		if (!isExactlyPermanentExtensionRepState(initialState)) formatDevErrorMessage(`ExtensionRep: Can not configure from state id ${String(initialState.id)}`);
		const initState = {
			getDependency: this.getInitDependency.bind(this),
			getDirectDependentNames: this.getDirectDependentNames.bind(this),
			getPeer: this.getInitPeer.bind(this),
			getPeerNameSet: this.getPeerNameSet.bind(this)
		};
		const buildState = {
			...initState,
			getDependency: this.getDependency.bind(this),
			getInitResult: this.getInitResult.bind(this),
			getPeer: this.getPeer.bind(this)
		};
		const state = applyConfiguredState(initialState, this.mergeConfigs(), initState);
		this.state = state;
		let initResult;
		if (this.extension.init) initResult = this.extension.init(editorConfig, state.config, initState);
		this.state = applyInitializedState(state, initResult, buildState);
	}
	build(editor) {
		const state = this.state;
		if (!(state.id === ExtensionRepStateIds.initialized)) formatDevErrorMessage(`ExtensionRep: register called in state id ${String(state.id)} (expected ${String(ExtensionRepStateIds.built)} initialized)`);
		let output;
		if (this.extension.build) output = this.extension.build(editor, state.config, state.registerState);
		const registerState = {
			...state.registerState,
			getOutput: () => output,
			getSignal: this.getSignal.bind(this)
		};
		this.state = applyBuiltState(state, output, registerState);
	}
	register(editor, signal) {
		this._signal = signal;
		const state = this.state;
		if (!(state.id === ExtensionRepStateIds.built)) formatDevErrorMessage(`ExtensionRep: register called in state id ${String(state.id)} (expected ${String(ExtensionRepStateIds.built)} built)`);
		const cleanup = this.extension.register && this.extension.register(editor, state.config, state.registerState);
		this.state = applyRegisteredState(state);
		return () => {
			const afterRegistrationState = this.state;
			if (!(afterRegistrationState.id === ExtensionRepStateIds.afterRegistration)) formatDevErrorMessage(`ExtensionRep: rollbackToBuiltState called in state id ${String(state.id)} (expected ${String(ExtensionRepStateIds.afterRegistration)} afterRegistration)`);
			this.state = rollbackToBuiltState(afterRegistrationState);
			if (cleanup) cleanup();
		};
	}
	afterRegistration(editor) {
		const state = this.state;
		if (!(state.id === ExtensionRepStateIds.registered)) formatDevErrorMessage(`ExtensionRep: afterRegistration called in state id ${String(state.id)} (expected ${String(ExtensionRepStateIds.registered)} registered)`);
		let rval;
		if (this.extension.afterRegistration) rval = this.extension.afterRegistration(editor, state.config, state.registerState);
		this.state = applyAfterRegistrationState(state);
		return rval;
	}
	getSignal() {
		if (!(this._signal !== void 0)) formatDevErrorMessage(`ExtensionRep.getSignal() called before register`);
		return this._signal;
	}
	getInitResult() {
		if (!(this.extension.init !== void 0)) formatDevErrorMessage(`ExtensionRep: getInitResult() called for Extension ${this.extension.name} that does not define init`);
		const state = this.state;
		if (!isInitializedExtensionRepState(state)) formatDevErrorMessage(`ExtensionRep: getInitResult() called for ExtensionRep in state id ${String(state.id)} < ${String(ExtensionRepStateIds.initialized)} (initialized)`);
		return state.initResult;
	}
	getInitPeer(name) {
		const rep = this.builder.extensionNameMap.get(name);
		return rep ? rep.getExtensionInitDependency() : void 0;
	}
	getExtensionInitDependency() {
		const state = this.state;
		if (!isConfiguredExtensionRepState(state)) formatDevErrorMessage(`ExtensionRep: getExtensionInitDependency called in state id ${String(state.id)} (expected >= ${String(ExtensionRepStateIds.configured)} configured)`);
		return { config: state.config };
	}
	getPeer(name) {
		const rep = this.builder.extensionNameMap.get(name);
		return rep ? rep.getExtensionDependency() : void 0;
	}
	getInitDependency(dep) {
		const rep = this.builder.getExtensionRep(dep);
		if (!(rep !== void 0)) formatDevErrorMessage(`LexicalExtensionBuilder: Extension ${this.extension.name} missing dependency extension ${dep.name} to be in registry`);
		return rep.getExtensionInitDependency();
	}
	getDependency(dep) {
		const rep = this.builder.getExtensionRep(dep);
		if (!(rep !== void 0)) formatDevErrorMessage(`LexicalExtensionBuilder: Extension ${this.extension.name} missing dependency extension ${dep.name} to be in registry`);
		return rep.getExtensionDependency();
	}
	getState() {
		const state = this.state;
		if (!isAfterRegistrationState(state)) formatDevErrorMessage(`ExtensionRep getState called in state id ${String(state.id)} (expected ${String(ExtensionRepStateIds.afterRegistration)} afterRegistration)`);
		return state;
	}
	getDirectDependentNames() {
		return this.builder.incomingEdges.get(this.extension.name) || emptySet;
	}
	getPeerNameSet() {
		let s = this._peerNameSet;
		if (!s) {
			s = new Set((this.extension.peerDependencies || []).map(([name]) => name));
			this._peerNameSet = s;
		}
		return s;
	}
	getExtensionDependency() {
		if (!this._dependency) {
			const state = this.state;
			if (!isBuiltExtensionRepState(state)) formatDevErrorMessage(`Extension ${this.extension.name} used as a dependency before build`);
			this._dependency = {
				config: state.config,
				init: state.initResult,
				output: state.output
			};
		}
		return this._dependency;
	}
};
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
var HISTORY_MERGE_OPTIONS = { tag: HISTORY_MERGE_TAG };
function $defaultInitializer() {
	const root = $getRoot();
	if (root.isEmpty()) root.append($createParagraphNode());
}
/**
* An extension to set the initial state of the editor from
* a function or serialized JSON EditorState. This is
* implicitly included with all editors built with
* Lexical Extension. This happens in the `afterRegistration`
* phase so your initial state may depend on registered commands,
* but you should not call `editor.setRootElement` earlier than
* this phase to avoid rendering an empty editor first.
*/
var InitialStateExtension = /* @__PURE__ */ defineExtension({
	config: /* @__PURE__ */ safeCast({
		setOptions: HISTORY_MERGE_OPTIONS,
		updateOptions: HISTORY_MERGE_OPTIONS
	}),
	init({ $initialEditorState = $defaultInitializer }) {
		return {
			$initialEditorState,
			initialized: false
		};
	},
	afterRegistration(editor, { updateOptions, setOptions }, state) {
		const initResult = state.getInitResult();
		if (!initResult.initialized) {
			initResult.initialized = true;
			const { $initialEditorState } = initResult;
			if ($isEditorState($initialEditorState)) editor.setEditorState($initialEditorState, setOptions);
			else if (typeof $initialEditorState === "function") editor.update(() => {
				$initialEditorState(editor);
			}, updateOptions);
			else if ($initialEditorState && (typeof $initialEditorState === "string" || typeof $initialEditorState === "object")) {
				const parsedEditorState = editor.parseEditorState($initialEditorState);
				editor.setEditorState(parsedEditorState, setOptions);
			}
		}
		return () => {};
	},
	name: "@lexical/extension/InitialState",
	nodes: [
		RootNode,
		TextNode,
		LineBreakNode,
		TabNode,
		ParagraphNode
	]
});
/** @internal Use a well-known symbol for dev tools purposes */
var builderSymbol = Symbol.for("@lexical/extension/LexicalBuilder");
/**
* Build a LexicalEditor by combining together one or more extensions, optionally
* overriding some of their configuration.
*
* @param extensions - Extension arguments (extensions or extensions with config overrides)
* @returns An editor handle
*
* @example
* A single root extension with multiple dependencies
*
* ```ts
* const editor = buildEditorFromExtensions(
*   defineExtension({
*     name: "[root]",
*     dependencies: [
*       RichTextExtension,
*       configExtension(EmojiExtension, { emojiBaseUrl: "/assets/emoji" }),
*     ],
*     register: (editor: LexicalEditor) => {
*       console.log("Editor Created");
*       return () => console.log("Editor Disposed");
*     },
*   }),
* );
* ```
*
* @example
* A very similar minimal configuration without the register hook
*
* ```ts
* const editor = buildEditorFromExtensions(
*   RichTextExtension,
*   configExtension(EmojiExtension, { emojiBaseUrl: "/assets/emoji" }),
* );
* ```
*/
function buildEditorFromExtensions(...extensions) {
	return LexicalBuilder.fromExtensions(extensions).buildEditor();
}
/** @internal */
function noop() {}
/** Throw the given Error */
function defaultOnError(err) {
	throw err;
}
/** @internal */
function maybeWithBuilder(editor) {
	return editor;
}
function normalizeExtensionArgument(arg) {
	return Array.isArray(arg) ? arg : [arg];
}
var PACKAGE_VERSION = LEXICAL_VERSION;
/** @internal */
var LexicalBuilder = class LexicalBuilder {
	roots;
	extensionNameMap;
	outgoingConfigEdges;
	incomingEdges;
	conflicts;
	_sortedExtensionReps;
	PACKAGE_VERSION;
	constructor(roots) {
		this.outgoingConfigEdges = /* @__PURE__ */ new Map();
		this.incomingEdges = /* @__PURE__ */ new Map();
		this.extensionNameMap = /* @__PURE__ */ new Map();
		this.conflicts = /* @__PURE__ */ new Map();
		this.PACKAGE_VERSION = PACKAGE_VERSION;
		this.roots = roots;
		for (const extension of roots) this.addExtension(extension);
	}
	static fromExtensions(extensions) {
		const roots = [normalizeExtensionArgument(InitialStateExtension)];
		for (const extension of extensions) roots.push(normalizeExtensionArgument(extension));
		return new LexicalBuilder(roots);
	}
	static maybeFromEditor(editor) {
		const builder = maybeWithBuilder(editor)[builderSymbol];
		if (builder) {
			if (!(builder.PACKAGE_VERSION === PACKAGE_VERSION)) formatDevErrorMessage(`LexicalBuilder.fromEditor: The given editor was created with LexicalBuilder ${builder.PACKAGE_VERSION} but this version is ${PACKAGE_VERSION}. A project should have exactly one copy of LexicalBuilder`);
			if (!(builder instanceof LexicalBuilder)) formatDevErrorMessage(`LexicalBuilder.fromEditor: There are multiple copies of the same version of LexicalBuilder in your project, and this editor was created with another one. Your project, or one of its dependencies, has its package.json and/or bundler configured incorrectly.`);
		}
		return builder;
	}
	/** Look up the editor that was created by this LexicalBuilder or throw */
	static fromEditor(editor) {
		const builder = LexicalBuilder.maybeFromEditor(editor);
		if (!(builder !== void 0)) formatDevErrorMessage(`LexicalBuilder.fromEditor: The given editor was not created with LexicalBuilder`);
		return builder;
	}
	constructEditor() {
		const { $initialEditorState: _$initialEditorState, onError, onWarn, ...editorConfig } = this.buildCreateEditorArgs();
		const editor = Object.assign(createEditor({
			...editorConfig,
			...onError ? { onError: (err) => {
				onError(err, editor);
			} } : {},
			...onWarn ? { onWarn: (err) => {
				onWarn(err, editor);
			} } : {}
		}), { [builderSymbol]: this });
		for (const extensionRep of this.sortedExtensionReps()) extensionRep.build(editor);
		return editor;
	}
	buildEditor() {
		let disposeOnce = noop;
		function dispose() {
			try {
				disposeOnce();
			} finally {
				disposeOnce = noop;
			}
		}
		const editor = Object.assign(this.constructEditor(), {
			dispose,
			[Symbol.dispose]: dispose
		});
		disposeOnce = mergeRegister(this.registerEditor(editor), () => editor.setRootElement(null));
		return editor;
	}
	hasExtensionByName(name) {
		return this.extensionNameMap.has(name);
	}
	getExtensionRep(extension) {
		const rep = this.extensionNameMap.get(extension.name);
		if (rep) {
			if (!(rep.extension === extension)) formatDevErrorMessage(`LexicalBuilder: A registered extension with name ${extension.name} exists but does not match the given extension`);
			return rep;
		}
	}
	/**
	* @param configs - Ownership passes to the builder, which retains the array
	*   and may append to it. Callers must pass an array nobody else holds.
	*/
	addEdge(fromExtensionName, toExtensionName, configs) {
		const outgoing = this.outgoingConfigEdges.get(fromExtensionName);
		if (outgoing) {
			const existing = outgoing.get(toExtensionName);
			if (existing) existing.push(...configs);
			else outgoing.set(toExtensionName, configs);
		} else this.outgoingConfigEdges.set(fromExtensionName, new Map([[toExtensionName, configs]]));
		const incoming = this.incomingEdges.get(toExtensionName);
		if (incoming) incoming.add(fromExtensionName);
		else this.incomingEdges.set(toExtensionName, new Set([fromExtensionName]));
	}
	addExtension(arg) {
		if (!(this._sortedExtensionReps === void 0)) formatDevErrorMessage(`LexicalBuilder: addExtension called after finalization`);
		const [extension] = normalizeExtensionArgument(arg);
		if (!(typeof extension.name === "string")) formatDevErrorMessage(`LexicalBuilder: extension name must be string, not ${typeof extension.name}`);
		let extensionRep = this.extensionNameMap.get(extension.name);
		if (!(extensionRep === void 0 || extensionRep.extension === extension)) formatDevErrorMessage(`LexicalBuilder: Multiple extensions registered with name ${extension.name}, names must be unique`);
		if (!extensionRep) {
			extensionRep = new ExtensionRep(this, extension);
			this.extensionNameMap.set(extension.name, extensionRep);
			const hasConflict = this.conflicts.get(extension.name);
			if (typeof hasConflict === "string") formatDevErrorMessage(`LexicalBuilder: extension ${extension.name} conflicts with ${hasConflict}`);
			for (const name of extension.conflictsWith || []) {
				if (!!this.extensionNameMap.has(name)) formatDevErrorMessage(`LexicalBuilder: extension ${extension.name} conflicts with ${name}`);
				this.conflicts.set(name, extension.name);
			}
			for (const dep of extension.dependencies || []) {
				const normDep = normalizeExtensionArgument(dep);
				this.addEdge(extension.name, normDep[0].name, normDep.slice(1));
				this.addExtension(normDep);
			}
			for (const [depName, config] of extension.peerDependencies || []) this.addEdge(extension.name, depName, config ? [config] : []);
		}
	}
	sortedExtensionReps() {
		if (this._sortedExtensionReps) return this._sortedExtensionReps;
		const sortedExtensionReps = [];
		const visit = (rep, fromExtensionName) => {
			let mark = rep.state;
			if (isExactlyPermanentExtensionRepState(mark)) return;
			const extensionName = rep.extension.name;
			if (!isExactlyUnmarkedExtensionRepState(mark)) formatDevErrorMessage(`LexicalBuilder: Circular dependency detected for Extension ${extensionName} from ${fromExtensionName || "[unknown]"}`);
			mark = applyTemporaryMark(mark);
			rep.state = mark;
			const outgoingConfigEdges = this.outgoingConfigEdges.get(extensionName);
			if (outgoingConfigEdges) for (const toExtensionName of outgoingConfigEdges.keys()) {
				const toRep = this.extensionNameMap.get(toExtensionName);
				if (toRep) visit(toRep, extensionName);
			}
			mark = applyPermanentMark(mark);
			rep.state = mark;
			sortedExtensionReps.push(rep);
		};
		for (const rep of this.extensionNameMap.values()) if (isExactlyUnmarkedExtensionRepState(rep.state)) visit(rep);
		for (const rep of sortedExtensionReps) for (const [toExtensionName, configs] of this.outgoingConfigEdges.get(rep.extension.name) || []) if (configs.length > 0) {
			const toRep = this.extensionNameMap.get(toExtensionName);
			if (toRep) for (const config of configs) toRep.configs.add(config);
		}
		for (const [extension, ...configs] of this.roots) if (configs.length > 0) {
			const toRep = this.extensionNameMap.get(extension.name);
			if (!(toRep !== void 0)) formatDevErrorMessage(`LexicalBuilder: Expecting existing ExtensionRep for ${extension.name}`);
			for (const config of configs) toRep.configs.add(config);
		}
		this._sortedExtensionReps = sortedExtensionReps;
		return this._sortedExtensionReps;
	}
	registerEditor(editor) {
		const extensionReps = this.sortedExtensionReps();
		const controller = new AbortController();
		const cleanups = [() => controller.abort()];
		const signal = controller.signal;
		for (const extensionRep of extensionReps) {
			const cleanup = extensionRep.register(editor, signal);
			if (cleanup) cleanups.push(cleanup);
		}
		for (const extensionRep of extensionReps) {
			const cleanup = extensionRep.afterRegistration(editor);
			if (cleanup) cleanups.push(cleanup);
		}
		return mergeRegister(...cleanups);
	}
	buildCreateEditorArgs() {
		const config = {};
		const nodes = /* @__PURE__ */ new Set();
		const replacedNodes = /* @__PURE__ */ new Map();
		const htmlExport = /* @__PURE__ */ new Map();
		const htmlImport = {};
		const theme = {};
		const extensionReps = this.sortedExtensionReps();
		for (const extensionRep of extensionReps) {
			const { extension } = extensionRep;
			if (extension.onError !== void 0) config.onError = extension.onError;
			if (extension.onWarn !== void 0) config.onWarn = extension.onWarn;
			if (extension.disableEvents !== void 0) config.disableEvents = extension.disableEvents;
			if (extension.parentEditor !== void 0) config.parentEditor = extension.parentEditor;
			if (extension.editable !== void 0) config.editable = extension.editable;
			if (extension.namespace !== void 0) config.namespace = extension.namespace;
			if (extension.$initialEditorState !== void 0) config.$initialEditorState = extension.$initialEditorState;
			if (extension.nodes) for (const node of getNodeConfig(extension)) {
				if (typeof node !== "function") {
					const conflictExtension = replacedNodes.get(node.replace);
					if (conflictExtension) formatDevErrorMessage(`LexicalBuilder: Extension ${extension.name} can not register replacement for node ${node.replace.name} because ${conflictExtension.extension.name} already did`);
					replacedNodes.set(node.replace, extensionRep);
				}
				nodes.add(node);
			}
			if (extension.html) {
				if (extension.html.export) for (const [k, v] of extension.html.export.entries()) htmlExport.set(k, v);
				if (extension.html.import) Object.assign(htmlImport, extension.html.import);
			}
			if (extension.theme) deepThemeMergeInPlace(theme, extension.theme);
		}
		if (Object.keys(theme).length > 0) config.theme = theme;
		if (nodes.size) config.nodes = [...nodes];
		const hasImport = Object.keys(htmlImport).length > 0;
		const hasExport = htmlExport.size > 0;
		if (hasImport || hasExport) {
			config.html = {};
			if (hasImport) config.html.import = htmlImport;
			if (hasExport) config.html.export = htmlExport;
		}
		for (const extensionRep of extensionReps) extensionRep.init(config);
		if (!config.onError) config.onError = defaultOnError;
		return config;
	}
};
/**
* Get the finalized config and output of an Extension that was used to build the editor.
*
* This is useful in the implementation of a LexicalNode or in other
* situations where you have an editor reference but it's not easy to
* pass the config or {@link ExtensionRegisterState} around.
*
* It will throw if the Editor was not built using this Extension.
*
* Inside an editor read/update, prefer {@link $getExtensionDependency} or
* {@link $getExtensionOutput} — they resolve the editor via `$getEditor()`
* so you don't have to thread it through.
*
* @param editor - The editor that was built using extension
* @param extension - The concrete reference to an Extension used to build this editor
* @returns The config and output for that Extension
*/
function getExtensionDependencyFromEditor(editor, extension) {
	const rep = LexicalBuilder.fromEditor(editor).getExtensionRep(extension);
	if (!(rep !== void 0)) formatDevErrorMessage(`getExtensionDependencyFromEditor: Extension ${extension.name} was not built when creating this editor`);
	return rep.getExtensionDependency();
}
/**
* Get the finalized config and output of an Extension that was used to build the
* editor by name.
*
* This can be used from the implementation of a LexicalNode or in other
* situation where you have an editor reference but it's not easy to pass the
* config around. Use this version if you do not have a concrete reference to
* the Extension for some reason (e.g. it is an optional peer dependency, or you
* are avoiding a circular import).
*
* Both the explicit Extension type and the name are required.
*
* Inside an editor read/update, prefer {@link $getPeerDependency} — it
* resolves the editor via `$getEditor()` so you don't have to thread it
* through.
*
*  @example
* ```tsx
* import type { HistoryExtension } from "@lexical/history";
* getPeerDependencyFromEditor<typeof HistoryExtension>(editor, "@lexical/history/History");
* ```

* @param editor - The editor that may have been built using extension
* @param extensionName - The name of the Extension
* @returns The config and output of the Extension or undefined
*/
function getPeerDependencyFromEditor(editor, extensionName) {
	const builder = LexicalBuilder.maybeFromEditor(editor);
	if (!builder) return void 0;
	const peer = builder.extensionNameMap.get(extensionName);
	return peer ? peer.getExtensionDependency() : void 0;
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Get the finalized config and output for `extension` from the editor
* currently in scope. A `$`-flavored shorthand for
* `getExtensionDependencyFromEditor($getEditor(), extension)`.
*
* Throws if the editor was not built with `extension` as a dependency.
*
* @example
* ```ts
* import {$getExtensionDependency} from '@lexical/extension';
* import {KeywordsExtension} from './KeywordsExtension';
*
* class KeywordNode extends TextNode {
*   createDOM(config: EditorConfig): HTMLElement {
*     const dom = super.createDOM(config);
*     dom.className =
*       $getExtensionDependency(KeywordsExtension).config.className;
*     return dom;
*   }
* }
* ```
*
* @see {@link getExtensionDependencyFromEditor} when you have an explicit
*   editor reference (e.g. outside a read/update).
*/
function $getExtensionDependency(extension) {
	return getExtensionDependencyFromEditor($getEditor(), extension);
}
/**
* Shorthand for `$getExtensionDependency(extension).output` — the most
* common reason to look up an extension dependency. Throws if the editor
* was not built with `extension` as a dependency.
*
* @example
* ```ts
* import {$getExtensionOutput} from '@lexical/extension';
* import {DOMImportExtension} from '@lexical/html';
*
* const nodes = $getExtensionOutput(DOMImportExtension).$generateNodesFromDOM(
*   dom,
* );
* ```
*
* @see {@link $getExtensionDependency} when you need both `.config` and
*   `.output` (or want to mirror the shape of
*   {@link getExtensionDependencyFromEditor}).
*/
function $getExtensionOutput(extension) {
	return $getExtensionDependency(extension).output;
}
/**
* Get the finalized config and output for an optional peer extension by
* name, from the editor currently in scope. A `$`-flavored shorthand for
* `getPeerDependencyFromEditor($getEditor(), extensionName)`.
*
* Returns `undefined` if the editor was not built with the named
* extension. Both the explicit `Extension` type and the name are
* required so the returned `config` / `output` types are correct.
*
* @example
* ```ts
* import {$getPeerDependency} from '@lexical/extension';
* import type {HistoryExtension} from '@lexical/history';
*
* const dep = $getPeerDependency<typeof HistoryExtension>(
*   '@lexical/history/History',
* );
* if (dep) {
*   // …read dep.config / dep.output…
* }
* ```
*
* @see {@link getPeerDependencyFromEditor} when you have an explicit
*   editor reference.
*/
function $getPeerDependency(extensionName) {
	return getPeerDependencyFromEditor($getEditor(), extensionName);
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
var EMPTY_SET = /* @__PURE__ */ new Set();
/**
* An extension that provides a `watchNodeKey` output that
* returns a signal for the selection state of a node.
*
* Typically used for tracking whether a DecoratorNode is
* currently selected or not. A framework independent
* alternative to {@link useLexicalNodeSelection}.
*/
var NodeSelectionExtension = /* @__PURE__ */ defineExtension({
	build(editor, config, state) {
		const editorStateStore = state.getDependency(EditorStateExtension).output;
		const watchedNodeStore = a({ watchedNodeKeys: /* @__PURE__ */ new Map() });
		const selectedNodeKeys = watchedSignal(() => void 0, () => j(() => {
			const prevSelectedNodeKeys = selectedNodeKeys.peek();
			const { watchedNodeKeys } = watchedNodeStore.value;
			let nextSelectedNodeKeys;
			let didChange = false;
			editorStateStore.value.read(() => {
				if ($getSelection()) for (const [key, listeners] of watchedNodeKeys.entries()) {
					if (listeners.size === 0) {
						watchedNodeKeys.delete(key);
						continue;
					}
					const node = $getNodeByKey(key);
					const isSelected = node && node.isSelected() || false;
					didChange = didChange || isSelected !== (prevSelectedNodeKeys ? prevSelectedNodeKeys.has(key) : false);
					if (isSelected) {
						nextSelectedNodeKeys = nextSelectedNodeKeys || /* @__PURE__ */ new Set();
						nextSelectedNodeKeys.add(key);
					}
				}
			});
			if (!(!didChange && nextSelectedNodeKeys && prevSelectedNodeKeys && nextSelectedNodeKeys.size === prevSelectedNodeKeys.size)) selectedNodeKeys.value = nextSelectedNodeKeys;
		}));
		function watchNodeKey(key) {
			const watcher = g(() => (selectedNodeKeys.value || EMPTY_SET).has(key));
			const { watchedNodeKeys } = watchedNodeStore.peek();
			let listeners = watchedNodeKeys.get(key);
			const hadListener = listeners !== void 0;
			listeners = listeners || /* @__PURE__ */ new Set();
			listeners.add(watcher);
			if (!hadListener) {
				watchedNodeKeys.set(key, listeners);
				watchedNodeStore.value = { watchedNodeKeys };
			}
			return watcher;
		}
		return { watchNodeKey };
	},
	dependencies: [EditorStateExtension],
	name: "@lexical/extension/NodeSelection"
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* The serialized form of a {@link HorizontalRuleNode}. It has no extra fields
* beyond the base serialized node.
*/
/**
* Command that inserts a {@link HorizontalRuleNode} at the current selection.
* Dispatch it with
* `editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND)`.
*/
var INSERT_HORIZONTAL_RULE_COMMAND = /* @__PURE__ */ createCommand("INSERT_HORIZONTAL_RULE_COMMAND");
var HorizontalRuleNode = class extends DecoratorNode {
	$config() {
		return this.config("horizontalrule", { importDOM: { hr: () => ({
			conversion: $convertHorizontalRuleElement,
			priority: 0
		}) } });
	}
	exportDOM() {
		return { element: $getDocument().createElement("hr") };
	}
	createDOM(config) {
		const element = $getDocument().createElement("hr");
		addClassNamesToElement(element, config.theme.hr);
		return element;
	}
	getTextContent() {
		return "\n";
	}
	isInline() {
		return false;
	}
	updateDOM() {
		return false;
	}
};
function $convertHorizontalRuleElement() {
	return { node: $createHorizontalRuleNode() };
}
function $createHorizontalRuleNode() {
	return $create(HorizontalRuleNode);
}
/**
* @returns `true` if `node` is a {@link HorizontalRuleNode}, narrowing its type.
*/
function $isHorizontalRuleNode(node) {
	return node instanceof HorizontalRuleNode;
}
function $toggleNodeSelection(node, shiftKey = false) {
	const selection = $getSelection();
	const wasSelected = node.isSelected();
	const key = node.getKey();
	let nodeSelection;
	if (shiftKey && $isNodeSelection(selection)) nodeSelection = selection;
	else {
		nodeSelection = $createNodeSelection();
		$setSelection(nodeSelection);
	}
	if (wasSelected) nodeSelection.delete(key);
	else nodeSelection.add(key);
}
/**
* An extension for HorizontalRuleNode that provides an implementation that
* works without any React dependency.
*/
var HorizontalRuleExtension = /* @__PURE__ */ defineExtension({
	dependencies: [EditorStateExtension, NodeSelectionExtension],
	name: "@lexical/extension/HorizontalRule",
	nodes: () => [HorizontalRuleNode],
	register(editor, config, state) {
		const { watchNodeKey } = state.getDependency(NodeSelectionExtension).output;
		const nodeSelectionStore = a({ nodeSelections: /* @__PURE__ */ new Map() });
		const isSelectedClassName = editor._config.theme.hrSelected ?? "selected";
		return mergeRegister(editor.registerCommand(INSERT_HORIZONTAL_RULE_COMMAND, (type) => {
			const selection = $getSelection();
			if (!$isRangeSelection(selection)) return false;
			if (selection.focus.getNode() !== null) $insertNodeToNearestRoot($createHorizontalRuleNode());
			return true;
		}, 0), editor.registerCommand(CLICK_COMMAND, (event) => {
			if (isDOMNode(event.target)) {
				const node = $getNodeFromDOMNode(event.target);
				if ($isHorizontalRuleNode(node)) {
					$toggleNodeSelection(node, event.shiftKey);
					return true;
				}
			}
			return false;
		}, 1), editor.registerMutationListener(HorizontalRuleNode, (nodes, payload) => {
			n(() => {
				let didChange = false;
				const { nodeSelections } = nodeSelectionStore.peek();
				for (const [k, v] of nodes.entries()) if (v === "destroyed") {
					nodeSelections.delete(k);
					didChange = true;
				} else {
					const prev = nodeSelections.get(k);
					const dom = editor.getElementByKey(k);
					if (prev) prev.domNode.value = dom;
					else {
						didChange = true;
						nodeSelections.set(k, {
							domNode: a(dom),
							selectedSignal: watchNodeKey(k)
						});
					}
				}
				if (didChange) nodeSelectionStore.value = { nodeSelections };
			});
		}), j(() => {
			const effects = [];
			for (const { domNode, selectedSignal } of nodeSelectionStore.value.nodeSelections.values()) effects.push(j(() => {
				const dom = domNode.value;
				if (dom) if (selectedSignal.value) addClassNamesToElement(dom, isSelectedClassName);
				else removeClassNamesFromElement(dom, isSelectedClassName);
			}));
			return mergeRegister(...effects);
		}));
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Centralizes IME composition state so extensions that react to
* composition lifecycle don't each re-implement the
* COMPOSITION_START_COMMAND + compositionend listener dance.
*
* Exposes two signals (both always-active for the editor's lifetime —
* listeners are wired up by `register`, not lazily on subscription, so
* consumers can read `.value` from anywhere without holding a
* subscription themselves):
*
* - `compositionKey` is the raw mirror — the value Lexical's own
*   `$handleCompositionStart` writes to its internal `_compositionKey`,
*   i.e. the `selection.anchor.key` at the moment composition starts.
*   This can be a non-TextNode key when composition begins on an
*   element-anchor selection (e.g. empty paragraph). Cleared on
*   `compositionend`.
*
* - `composingTextNode` is the resolved view — the actual TextNode
*   being composed on, or `null` while there is no TextNode-level
*   composition. For an element-anchor start it stays `null` until
*   the `COMPOSITION_START_TAG`-tagged update fires with the
*   post-ZWSP-heuristic selection, at which point it updates to the
*   new TextNode.
*
*/
var IMEExtension = /* @__PURE__ */ defineExtension({
	build(_editor) {
		return {
			composingTextNode: a(null),
			compositionKey: a(null)
		};
	},
	name: "@lexical/extension/IME",
	register(editor, _config, state) {
		const { compositionKey, composingTextNode } = state.getOutput();
		return mergeRegister(editor.registerCommand(COMPOSITION_START_COMMAND, () => {
			const selection = $getSelection();
			if ($isRangeSelection(selection)) compositionKey.value = selection.anchor.key;
			return false;
		}, -8), j(() => {
			const key = compositionKey.value;
			if (key === null) {
				composingTextNode.value = null;
				return;
			}
			composingTextNode.value = editor.read("latest", () => {
				const node = $getNodeByKey(key);
				return $isTextNode(node) ? node : null;
			});
		}), editor.registerUpdateListener(({ tags, editorState }) => {
			if (!tags.has("composition-start")) return;
			editorState.read(() => {
				const selection = $getSelection();
				if (!$isRangeSelection(selection)) return;
				const node = selection.anchor.getNode();
				if ($isTextNode(node)) composingTextNode.value = node;
			});
		}), editor.registerRootListener((rootElem) => {
			if (rootElem === null) {
				compositionKey.value = null;
				return;
			}
			const onCompositionEnd = () => {
				compositionKey.value = null;
			};
			return registerEventListener(rootElem, "compositionend", onCompositionEnd);
		}));
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
var MODIFIERS = [
	["ctrlKey", "Ctrl"],
	["altKey", "Alt"],
	["shiftKey", "Shift"],
	["metaKey", "Meta"]
];
var UNIVERSAL_KEYS = { " ": "Space" };
var APPLE_KEYS = {
	...UNIVERSAL_KEYS,
	Alt: "⌥",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	ArrowUp: "↑",
	Backspace: "⌫",
	CapsLock: "⇪",
	Ctrl: "⌃",
	Delete: "⌦",
	End: "↘",
	Enter: "↩",
	Escape: "⎋",
	Home: "↖",
	Meta: "⌘",
	PageDown: "⇟",
	PageUp: "⇞",
	Shift: "⇧",
	Tab: "⇥"
};
var SHIFT_APPLE_KEYS = {
	...APPLE_KEYS,
	Tab: "⇤"
};
/**
* Format the key binding of a shortcut as a human readable string for
* menus, tooltips, and help dialogs (e.g. `'⌘+Shift+K'` on Apple platforms
* and `'Ctrl+Shift+K'` elsewhere). Modifiers with an `'any'` mask are not
* displayed.
*/
function formatKeyboardShortcut(shortcut, options = {}) {
	const { isApple = IS_APPLE } = options;
	const { unshiftedKey, key } = shortcut;
	const modifiers = keyboardEventMaskForPlatform(shortcut.modifiers || {}, isApple);
	const segments = [];
	const keyNames = isApple ? modifiers.shiftKey === true ? SHIFT_APPLE_KEYS : APPLE_KEYS : UNIVERSAL_KEYS;
	for (const [k, name] of MODIFIERS) if (modifiers[k] === true) {
		if (isApple && k === "shiftKey" && unshiftedKey && key.length === 1) continue;
		segments.push(keyNames[name] || name);
	}
	segments.push(keyNames[key] || !isApple && modifiers.shiftKey === true && unshiftedKey || key.length === 1 && key.toUpperCase() || key);
	return segments;
}
/**
* Keyboard shortcuts by name. The names exist so that other extensions and
* applications can overlay the table: configuring an existing name remaps
* that shortcut, configuring it to null disables it, and new names add new
* shortcuts.
* @experimental
*/
/**
* Configuration for {@link KeyboardShortcutsExtension}.
* @experiemental
*/
/**
* @experimental @internal
*
* Compile the given shortcuts and register a single
* {@link KEY_DOWN_COMMAND} listener that dispatches each matched shortcut's
* command with the KeyboardEvent as its payload (unless its `$disabled`
* predicate returns true for the current selection). When several
* shortcuts match the same event they are tried in the given order until
* one command dispatch is handled.
*
* @returns A cleanup function that unregisters the listener.
*/
function registerKeyboardShortcuts(editor, shortcuts, priority) {
	const compiled = compileKeyboardShortcuts(shortcuts);
	return editor.registerCommand(KEY_DOWN_COMMAND, (event, fromEditor) => {
		let selection;
		for (const shortcut of compiled.matches(event)) {
			if (editor !== fromEditor && !shortcut.bubbleFromNestedEditors) continue;
			if (shortcut.$disabled) {
				if (selection === void 0) selection = $getSelection();
				if (shortcut.$disabled(selection, fromEditor)) continue;
			}
			const $next = fromEditor.dispatchCommand.bind(fromEditor, shortcut.command, event);
			if (shortcut.$dispatch ? shortcut.$dispatch(shortcut.command, event, $next, fromEditor) : $next()) return true;
		}
		return false;
	}, priority);
}
function isReadonlyArray(x) {
	return Array.isArray(x);
}
function flattenKeyboardShortcuts(shortcuts) {
	return isReadonlyArray(shortcuts) ? shortcuts : shortcuts ? [shortcuts] : [];
}
/**
* Merge by name, as {@link shallowMergeConfig} would, except that the
* overriding names come *first* in object entry iteration so that they are
* also the first to be offered a matching keypress.
*/
function mergeNamedShortcuts(config, overrides) {
	if (!overrides) return config;
	const dest = { ...overrides };
	for (const [k, v0] of Object.entries(config)) if (dest[k] === void 0) dest[k] = v0;
	return dest;
}
/**
* @experimental
*
* Dispatches a table of keyboard shortcuts from a single compiled
* `KEY_DOWN_COMMAND` listener, in O(1) per keypress.
*
* The table is merged across the whole extension graph by name: any
* extension or app config can add shortcuts under new names, remap an
* existing name to a different key or handler, or disable one by
* configuring it to null. The output exposes the config as signals, so the
* table can also be remapped at runtime through the `shortcuts` signal
* (the listener is recompiled on change).
*
* Configuring an existing name always replaces its mapping outright, and a
* name may be mapped to an array to give it several bindings at once. The
* overriding names are also matched first, ahead of the names they did not
* override, when more than one shortcut matches the same keypress.
*/
var KeyboardShortcutsExtension = /* @__PURE__ */ defineExtension({
	build(editor, config, state) {
		return namedSignals(config);
	},
	config: /* @__PURE__ */ safeCast({
		disabled: false,
		priority: 2,
		shortcuts: {}
	}),
	mergeConfig(config, overrides) {
		const merged = shallowMergeConfig(config, overrides);
		merged.shortcuts = mergeNamedShortcuts(config.shortcuts, overrides.shortcuts);
		return merged;
	},
	name: "@lexical/extension/KeyboardShortcuts",
	register(editor, config, state) {
		const { disabled, priority, shortcuts } = state.getOutput();
		return j(() => {
			if (!disabled.value) {
				const allShortcuts = [];
				for (const shortcutConfig of Object.values(shortcuts.value)) for (const v of flattenKeyboardShortcuts(shortcutConfig)) allShortcuts.push(v);
				return registerKeyboardShortcuts(editor, allShortcuts, priority.value);
			}
		});
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function $defaultGetParentEditor() {
	const editor = $getEditor();
	LexicalBuilder.fromEditor(editor);
	return editor;
}
var NestedEditorExtension = /* @__PURE__ */ defineExtension({
	build: (editor, config) => namedSignals({ inheritEditableFromParent: config.inheritEditableFromParent }),
	config: /* @__PURE__ */ safeCast({
		$getParentEditor: $defaultGetParentEditor,
		inheritEditableFromParent: false
	}),
	init: (editorConfig, config, state) => {
		const parentEditor = config.$getParentEditor();
		editorConfig.parentEditor = parentEditor;
		editorConfig.theme = editorConfig.theme || parentEditor._config.theme;
	},
	name: "@lexical/extension/NestedEditor",
	register: (editor, config, state) => j(() => {
		const parentEditor = editor._parentEditor;
		if (parentEditor) {
			if (state.getOutput().inheritEditableFromParent.value) {
				editor.setEditable(parentEditor.isEditable());
				return parentEditor.registerEditableListener(editor.setEditable.bind(editor));
			}
		}
	})
});
/**
* @experimental
*
* Mirrors {@link NodeSelection} membership onto the host DOM as an attribute
* so CSS can render a selection outline for `ElementNode` hosts, which have
* no `decorate()` render path of their own. Configure it per node type:
*
* ```ts
* configExtension(NodeSelectionDataSelectedExtension, {nodes: [CardNode]})
* ```
*
* The matched host needs a corresponding CSS rule, e.g.
* `.lexical-card-node[data-selected='true'] { outline: ... }`.
*/
var NodeSelectionDataSelectedExtension = /* @__PURE__ */ defineExtension({
	config: /* @__PURE__ */ safeCast({
		attribute: "data-selected",
		nodes: []
	}),
	init(editorConfig, config) {
		const matchTypes = /* @__PURE__ */ new Set();
		const subtypeMap = getRegisteredSubtypeMap(getKnownTypesAndNodes(editorConfig).nodes);
		for (const klass of config.nodes) {
			const type = klass.getType();
			const subtypes = subtypeMap.get(type);
			if (!(subtypes !== void 0)) formatDevErrorMessage(`Node class ${klass.name} with type ${type} not registered in editor`);
			matchTypes.add(type);
			for (const subtype of subtypes) matchTypes.add(subtype);
		}
		return { matchTypes };
	},
	mergeConfig(config, partial) {
		return shallowMergeConfig(config, {
			...partial,
			...partial.nodes && { nodes: [...config.nodes, ...partial.nodes] }
		});
	},
	name: "@lexical/extension/NodeSelectionDataSelected",
	register(editor, config, state) {
		const { attribute } = config;
		const { matchTypes } = state.getInitResult();
		const marked = /* @__PURE__ */ new Map();
		const syncFromEditorState = (editorState) => {
			const nextKeys = /* @__PURE__ */ new Set();
			editorState.read(() => {
				const selection = $getSelection();
				if ($isNodeSelection(selection)) {
					for (const node of selection.getNodes()) if (matchTypes.has(node.getType())) nextKeys.add(node.getKey());
				}
			});
			for (const [key, dom] of marked) if (!nextKeys.has(key)) {
				dom.removeAttribute(attribute);
				marked.delete(key);
			}
			for (const key of nextKeys) {
				const dom = editor.getElementByKey(key);
				if (dom !== null) {
					dom.setAttribute(attribute, "true");
					marked.set(key, dom);
				}
			}
		};
		syncFromEditorState(editor.getEditorState());
		const removeUpdateListener = editor.registerUpdateListener(({ editorState }) => syncFromEditorState(editorState));
		return () => {
			removeUpdateListener();
			for (const dom of marked.values()) dom.removeAttribute(attribute);
			marked.clear();
		};
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function deleteEmptyInline(node) {
	if ($isElementNode(node) && node.isInline() && node.isEmpty()) {
		node.remove();
		if (node.canBeEmpty()) console.warn(`Empty inline elements are removed from the EditorState, so returning 'true' from ${node.constructor.name}.canBeEmpty() is not allowed`);
	}
}
/**
* This extension removes empty inline nodes from the EditorState.
* This extension is designed to facilitate a smooth migration from
* the plugin API with the option to disable it, but it may be removed
* in the future and integrated into the core
*/
var NormalizeInlineElementsExtension = /* @__PURE__ */ defineExtension({
	build: (editor, config, state) => namedSignals(config),
	config: /* @__PURE__ */ safeCast({ disabled: false }),
	name: "@lexical/NormalizeInlineElements",
	register: (editor, config, state) => {
		const stores = state.getOutput();
		return j(() => {
			if (!stores.disabled.value) {
				const disposeTransformers = [];
				for (const { klass, transforms } of editor._nodes.values()) if (klass.prototype instanceof ElementNode && klass.prototype.isInline !== ElementNode.prototype.isInline) {
					transforms.add(deleteEmptyInline);
					disposeTransformers.push(() => transforms.delete(deleteEmptyInline));
				}
				return () => disposeTransformers.forEach((fn) => fn());
			}
		});
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
var SKIP_TAGS = new Set([SKIP_SELECTION_FOCUS_TAG, SKIP_SCROLL_INTO_VIEW_TAG]);
function $fixFocusOverselection() {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return;
	if (!selection.isCollapsed()) {
		const range = $getCaretRangeInDirection($caretRangeFromSelection(selection), "next");
		let focusCaret = range.focus;
		if ($isTextPointCaret(focusCaret) && range.anchor.origin !== focusCaret.origin && focusCaret.offset === 0) focusCaret = $rewindSiblingCaret(focusCaret.getSiblingCaret());
		if ($isSiblingCaret(focusCaret) && range.anchor.origin !== focusCaret.origin && $isLineBreakNode(focusCaret.origin)) focusCaret = $rewindSiblingCaret(focusCaret);
		while ($isChildCaret(focusCaret) && range.anchor.origin !== focusCaret.origin) focusCaret = $rewindSiblingCaret($getSiblingCaret(focusCaret.origin, "next"));
		if ($isSiblingCaret(focusCaret) && $isElementNode(focusCaret.origin)) focusCaret = $normalizeCaret($getChildCaret(focusCaret.origin, "previous")).getFlipped();
		focusCaret = $normalizeCaret(focusCaret);
		if (!focusCaret.isSamePointCaret(range.focus)) {
			const sel = $setSelectionFromCaretRange($getCaretRange(range.anchor, focusCaret));
			const rootElement = $getEditor().getRootElement();
			const domSelection = rootElement && getDOMSelection(rootElement.ownerDocument.defaultView);
			if (domSelection) $updateDOMSelection($getPreviousSelection(), sel, $getEditor(), domSelection, SKIP_TAGS, rootElement);
		}
	}
}
/**
* This extension handles triple-click events and will move the focus
* towards the anchor in certain conditions to meet expectations.
* Simply speaking, the focus should prefer to land at the end of a node
* rather than the beginning of its next sibling, and it should not skip
* over a LineBreakNode.
*
* In order to fix the result visually and avoid a flash of over-selection
* it will also eagerly manipulate the DOM selection directly.
*
* It is conservative in that it only fires this
* `$fixFocusOverselection` callback when it has detected a triple click,
* but it provides the function as an output signal so that it can both
* be called from other places and it can be replaced or wrapped with
* different functionality.
*/
var NormalizeTripleClickSelectionExtension = /* @__PURE__ */ defineExtension({
	build: (editor, config, state) => namedSignals(config),
	config: /* @__PURE__ */ safeCast({
		$fixFocusOverselection,
		dateNow: Date.now,
		disabled: false,
		thresholdMsec: 100
	}),
	name: "@lexical/NormalizeTripleClickSelection",
	register: (editor, config, state) => j(() => {
		const stores = state.getOutput();
		if (stores.disabled.value) return;
		return editor.registerRootListener((rootElement) => {
			if (!rootElement) return;
			let lastTripleClick = 0;
			const refreshTripleClick = (event) => {
				if (event ? event.detail > 2 : lastTripleClick > 0) {
					const now = stores.dateNow.peek()();
					lastTripleClick = event && event.type === "mousedown" || now - lastTripleClick <= stores.thresholdMsec.peek() ? now : 0;
				}
				return lastTripleClick;
			};
			return mergeRegister(editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
				if (refreshTripleClick(null)) {
					lastTripleClick = 0;
					stores.$fixFocusOverselection.peek()();
				}
				return false;
			}, -4), registerEventListeners(rootElement, {
				mousedown: refreshTripleClick,
				mouseup: refreshTripleClick
			}, true));
		});
	})
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function captureKeydown(e) {
	const target = e.target;
	if (isExactShortcutMatch(e, "a", CONTROL_OR_META) && isHTMLElement(target) && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) target.addEventListener("keydown", stopLexicalPropagation, { once: true });
}
/**
* By default, lexical intercepts most events and dispatches the appropriate commands.
* This extension prevents the keydown event propagating from input/textarea elements,
* which are typically part of a decorator node, in order to stop dispatching the SELECT_ALL_COMMAND.
*
* When used as a dependency of SelectBlockExtension, its disabled state is
* kept in sync with that extension.
*/
var PreventSelectAllExtension = /* @__PURE__ */ defineExtension({
	build: (editor, config, state) => namedSignals(config),
	config: /* @__PURE__ */ safeCast({ disabled: false }),
	name: "@lexical/extension/PreventSelectAll",
	register: (editor, config, state) => {
		const stores = state.getOutput();
		return j(() => {
			if (!stores.disabled.value) return editor.registerRootListener((rootElement) => {
				if (rootElement) return registerEventListener(rootElement, "keydown", captureKeydown, true);
			});
		});
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Exposes the editor's current root element as a reactive
* `Signal<HTMLElement | null>` that mirrors `editor.getRootElement()` via a
* root listener.
*
* Depend on this extension and read its output `Signal` from a signals
* `effect`/`computed` to react to the root mounting, unmounting, or remounting
* (e.g. into a different document such as an iframe) without subscribing
* through React (or any other framework).
*/
var RootElementExtension = /* @__PURE__ */ defineExtension({
	build(editor) {
		return watchedSignal(() => editor.getRootElement(), (rootElementSignal) => editor.registerRootListener((rootElement) => {
			rootElementSignal.value = rootElement;
		}));
	},
	name: "@lexical/extension/RootElement"
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function $hasCommonTopParent(nodes, commonTopParent) {
	return nodes.every((node) => commonTopParent.is(node.getTopLevelElement()));
}
/**
* This extension includes block selection.
* If you press Ctrl + A, the nearest block element, for example paragraph, is selected first.
* Pressing Ctrl + A again selects all content in the document. A selection
* that already spans multiple blocks expands directly to the whole document.
*/
var SelectBlockExtension = /* @__PURE__ */ defineExtension({
	build: (editor, config, state) => namedSignals(config),
	config: /* @__PURE__ */ safeCast({
		cascadeSelection: false,
		disabled: false
	}),
	dependencies: [PreventSelectAllExtension],
	name: "@lexical/extension/SelectBlock",
	register: (editor, config, state) => {
		const stores = state.getOutput();
		const preventSelectAllStores = state.getDependency(PreventSelectAllExtension).output;
		return mergeRegister(j(() => {
			preventSelectAllStores.disabled.value = stores.disabled.value;
		}), j(() => {
			if (!stores.disabled.value) return editor.registerCommand(SELECT_ALL_COMMAND, (event, triggerEditor) => {
				if (triggerEditor !== editor) {
					if (!stores.cascadeSelection.peek()) return false;
					if (!triggerEditor.read("pending", () => {
						const nestedSelection = $getSelection();
						return $isRangeSelection(nestedSelection) && $isBlockFullySelected($getRoot(), nestedSelection);
					})) return false;
					$selectAll();
					return true;
				}
				const selection = $getSelection();
				if ($isNodeSelection(selection)) {
					const selectedNodes = selection.getNodes();
					const firstNode = selectedNodes[0];
					if (!firstNode) return false;
					const topParent = firstNode.getTopLevelElement();
					if (!topParent || $isRootNode(topParent) || topParent.is(firstNode) || selectedNodes.length > 1 && !$hasCommonTopParent(selectedNodes, topParent)) $selectAll();
					else if ($isElementNode(topParent)) topParent.select(0, topParent.getChildrenSize());
					return true;
				}
				if (!$isRangeSelection(selection)) return false;
				const anchorNode = selection.anchor.getNode();
				const blockNode = anchorNode.getTopLevelElement();
				if (blockNode && blockNode.is(selection.focus.getNode().getTopLevelElement()) && !$isBlockFullySelected(blockNode, selection)) {
					blockNode.select(0, blockNode.getChildrenSize());
					return true;
				}
				let frame = $getSlotFrame(anchorNode);
				while (frame !== null) {
					if ($isElementNode(frame) && !$isBlockFullySelected(frame, selection)) {
						frame.select(0, frame.getChildrenSize());
						return true;
					}
					const host = $getSlotHost(frame);
					frame = host === null ? null : $getSlotFrame(host);
				}
				if (!$isBlockFullySelected($getRoot(), selection)) $selectAll();
				return true;
			}, 1);
		}));
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* An extension that highlights selected content in the Lexical editor
* even when the editor is not currently focused.
*/
var SelectionAlwaysOnDisplayExtension = /* @__PURE__ */ defineExtension({
	build: (editor, config, state) => namedSignals(config),
	config: /* @__PURE__ */ safeCast({
		disabled: false,
		onReposition: void 0
	}),
	name: "@lexical/utils/SelectionAlwaysOnDisplay",
	register: (editor, config, state) => {
		const stores = state.getOutput();
		return j(() => {
			if (!stores.disabled.value) return selectionAlwaysOnDisplay(editor, stores.onReposition.value);
		});
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
function $indentOverTab(selection) {
	if (selection.getNodes().filter((node) => $isBlockElementNode(node) && node.canIndent()).length > 0) return true;
	const anchor = selection.anchor;
	const focus = selection.focus;
	const first = focus.isBefore(anchor) ? focus : anchor;
	const firstBlock = $getNearestBlockElementAncestorOrThrow(first.getNode());
	if (firstBlock.canIndent()) {
		const firstBlockKey = firstBlock.getKey();
		let selectionAtStart = $createRangeSelection();
		selectionAtStart.anchor.set(firstBlockKey, 0, "element");
		selectionAtStart.focus.set(firstBlockKey, 0, "element");
		selectionAtStart = $normalizeSelection(selectionAtStart);
		if (selectionAtStart.anchor.is(first)) return true;
	}
	return false;
}
function $defaultCanIndent(node) {
	return node.canIndent();
}
/**
* Registers a `KEY_TAB_COMMAND` handler that makes Tab and Shift+Tab indent and
* outdent block elements (and otherwise insert a tab). Pass `maxIndent` to cap
* the indent depth and `$canIndent` to control which elements may be indented.
*
* @returns A cleanup function that unregisters the handler.
*/
function registerTabIndentation(editor, maxIndent, $canIndent = $defaultCanIndent) {
	return mergeRegister(editor.registerCommand(KEY_TAB_COMMAND, (event) => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return false;
		event.preventDefault();
		const command = $indentOverTab(selection) ? event.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND : INSERT_TAB_COMMAND;
		return editor.dispatchCommand(command);
	}, 0), editor.registerCommand(INDENT_CONTENT_COMMAND, () => {
		const currentMaxIndent = typeof maxIndent === "number" ? maxIndent : maxIndent ? maxIndent.peek() : null;
		if (!$isRangeSelection($getSelection())) return false;
		const $currentCanIndent = typeof $canIndent === "function" ? $canIndent : $canIndent.peek();
		return $handleIndentAndOutdent((block) => {
			if ($currentCanIndent(block)) {
				const newIndent = block.getIndent() + 1;
				if (!currentMaxIndent || newIndent < currentMaxIndent) block.setIndent(newIndent);
			}
		});
	}, 4));
}
/**
* This extension adds the ability to indent content using the tab key. Generally, we don't
* recommend using this plugin as it could negatively affect accessibility for keyboard
* users, causing focus to become trapped within the editor.
*/
var TabIndentationExtension = /* @__PURE__ */ defineExtension({
	build(editor, config, state) {
		return namedSignals(config);
	},
	config: /* @__PURE__ */ safeCast({
		$canIndent: $defaultCanIndent,
		disabled: false,
		maxIndent: null
	}),
	name: "@lexical/extension/TabIndentation",
	register(editor, config, state) {
		const { disabled, maxIndent, $canIndent } = state.getOutput();
		return j(() => {
			if (!disabled.value) return registerTabIndentation(editor, maxIndent, $canIndent);
		});
	}
});
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
/**
* Exposes the editor's editable state as a reactive `Signal<boolean>` that
* mirrors `editor.isEditable()` via an editable listener.
*
* Depend on this extension and read its output `Signal` from a signals
* `effect`/`computed` to react to editability changes without subscribing
* through React (or any other framework).
*/
var WatchEditableExtension = /* @__PURE__ */ defineExtension({
	build(editor) {
		return watchedSignal(() => editor.isEditable(), (signal) => editor.registerEditableListener((editable) => {
			signal.value = editable;
		}));
	},
	name: "@lexical/extension/WatchEditable"
});
//#endregion
export { $isBlockFullySelected as $, formatKeyboardShortcut as A, $descendantsMatching as B, SelectionAlwaysOnDisplayExtension as C, $trimTextContentFromAnchor as Ct, applyFormatFromStyle as D, a as E, require_react_dom as Et, j as F, $getNearestNodeOfType as G, $dfsWithSlots as H, n as I, $insertFirst as J, $getNextRightPreorderNode as K, namedSignals as L, getExtensionDependencyFromEditor as M, getKnownTypesAndNodes as N, applyFormatToDom as O, getPeerDependencyFromEditor as P, $isAtStartOfNode as Q, registerClearEditor as R, SelectBlockExtension as S, $sliceSelectedTextNodeContent as St, WatchEditableExtension as T, createRectsFromDOMRange as Tt, $dfsWithSlotsIterator as U, $dfs as V, $getNearestBlockElementAncestorOrThrow as W, $insertNodeToNearestRoot as X, $insertNodeIntoLeaf as Y, $isAtEndOfNode as Z, NestedEditorExtension as _, $isParentRTL as _t, $isHorizontalRuleNode as a, $unwrapNode as at, NormalizeTripleClickSelectionExtension as b, $setBlocksType as bt, ClickAfterLastBlockExtension as c, eventFiles as ct, HorizontalRuleExtension as d, mediaFileReader as dt, $isEditorIsNestedEditor as et, HorizontalRuleNode as f, objectKlassEquals as ft, LexicalBuilder as g, $isParentElementRTL as gt, KeyboardShortcutsExtension as h, $isAtNodeEnd as ht, $getPeerDependency as i, $unwrapAndFilterDescendants as it, g as j, buildEditorFromExtensions as k, DecoratorTextExtension as l, getScrollParent as lt, INSERT_HORIZONTAL_RULE_COMMAND as m, $getSelectionStyleValueForProperty as mt, $defaultShouldInsertAfter as n, $onEscapeUp as nt, AutoFocusExtension as o, $wrapNodeInElement as ot, IMEExtension as p, registerNestedElementResolver as pt, $handleIndentAndOutdent as q, $getExtensionOutput as r, $restoreEditorState as rt, ClearEditorExtension as s, calculateZoomLevel as st, $createHorizontalRuleNode as t, $onEscapeDown as tt, DecoratorTextNode as u, isMimeType as ut, NodeSelectionDataSelectedExtension as v, $moveCharacter as vt, TabIndentationExtension as w, createDOMRange as wt, RootElementExtension as x, $shouldOverrideDefaultCharacterSelection as xt, NormalizeInlineElementsExtension as y, $patchStyleText as yt, watchedSignal as z };
