/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Simple queue for transmitting arrays of Int32 values - a useful
 * building block for other mechanisms.
 */

// REQUIRE
//   synchronic.js
//   arena.js

// Internal constants.
const _IQ_USED = 0;
const _IQ_HEAD = 1;
const _IQ_TAIL = 2;

/*
 * Construct an IntQueue object in any agent.
 *
 * sab must be a SharedArrayBuffer.
 * offset must be a valid offset within that array.
 * length must be the length of a segment within that array.
 * length-offset must have space for metadata and queue data.
 *   An upper bound on metadata is given by IntQueue.NUMBYTES.
 * If initialize==true then initialize the shared memory for the queue.
 *   Initialization must only be performed in one agent.
 *
 * Constructors may be called concurrently in all agents but the queue
 * must not be used in any agent until the constructor that performs
 * the initialization has returned.
 */
function IntQueue(sab, offset, length, initialize) {
    initialize = !!initialize;

    var intSize = 4;
    var synSize = SynchronicInt32.BYTES_PER_ELEMENT;
    var a = new Arena(sab, offset, length);
    this._spaceAvailable = new SynchronicInt32(sab, a.alloc(synSize, synSize), initialize);
    this._dataAvailable = new SynchronicInt32(sab, a.alloc(synSize, synSize), initialize);
    this._lock = new SynchronicInt32(sab, a.alloc(synSize, synSize), initialize);
    this._meta = new SharedInt32Array(sab, a.alloc(intSize*3, intSize), 3);
    var qlen = Math.floor(a.available(intSize) / intSize);
    this._queue = new SharedInt32Array(sab, a.alloc(intSize*qlen, intSize), qlen);

    if (initialize) {
	Atomics.store(this._meta, _IQ_USED, 0);
	Atomics.store(this._meta, _IQ_HEAD, 0);
	Atomics.store(this._meta, _IQ_TAIL, 0);
    }
}

/*
 * The number of bytes needed for metadata (upper bound, allowing for
 * bad alignment etc).
 */
IntQueue.NUMBYTES = 64;

/*
 * Enters an element into the queue, waits until space is available or
 * until t milliseconds (undefined == indefinite wait) have passed.
 *
 * ints is a dense Array of Int32 values.
 * Returns true if it succeeded, false if it timed out.
 */
IntQueue.prototype.enqueue = function(ints, t) {
    var required = ints.length + 1;

    if (!this._acquireWithSpaceAvailable(required, t))
	return false;

    var q = this._queue;
    var qlen = q.length;
    var tail = this._meta[_IQ_TAIL];
    q[tail] = ints.length;
    tail = (tail + 1) % qlen;
    for ( var i=0 ; i < ints.length ; i++ ) {
	q[tail] = ints[i];
	tail = (tail + 1) % qlen;
    }
    this._meta[_IQ_TAIL] = tail;
    this._meta[_IQ_USED] += required;

    this._releaseWithDataAvailable();
    return true;
}

/*
 * Returns an element from the queue if there's one, or waits up to t
 * milliseconds (undefined == indefinite wait) for one to appear,
 * returning null if none appears in that time.
 *
 * The element is returned as a dense Array of Int32 values.
 */
IntQueue.prototype.dequeue = function (t) {
    if (!this._acquireWithDataAvailable(t))
	return null;

    var A = [];
    var q = this._queue;
    var qlen = q.length;
    var head = this._meta[_IQ_HEAD];
    var count = q[head];
    head = (head + 1) % qlen;
    while (count-- > 0) {
	A.push(q[head]);
	head = (head + 1) % qlen;
    }
    this._meta[_IQ_HEAD] = head;
    this._meta[_IQ_USED] -= A.length + 1;

    this._releaseWithSpaceAvailable();
    return A;
}

// Internal code below this point

IntQueue.prototype._acquireWithSpaceAvailable = function (required, t) {
    var limit = typeof t != "undefined" ? Date.now() + t : Number.POSITIVE_INFINITY;
    for (;;) {
	this._acquire();
	if (this._queue.length - this._meta[_IQ_USED] >= required)
	    break;
	var probe = this._spaceAvailable.load();
	this._release();
	var remaining = limit - Date.now();
	if (remaining <= 0)
	    return false;
	this._dataAvailable.expectUpdate(probe, remaining);
    }
    return true;
}

IntQueue.prototype._acquireWithDataAvailable = function (t) {
    var limit = typeof t != "undefined" ? Date.now() + t : Number.POSITIVE_INFINITY;
    for (;;) {
	this._acquire();
	if (this._meta[_IQ_USED] > 0)
	    break;
	var probe = this._dataAvailable.load();
	this._release();
	var remaining = limit - Date.now();
	if (remaining <= 0)
	    return false;
	this._dataAvailable.expectUpdate(probe, remaining);
    }
    return true;
}

IntQueue.prototype._releaseWithSpaceAvailable = function() {
    this._spaceAvailable.add(1);
    this._release();
}

IntQueue.prototype._releaseWithDataAvailable = function() {
    this._dataAvailable.add(1);
    this._release();
}

IntQueue.prototype._acquire = function () {
    while (this._lock.compareExchange(0, 1) != 0)
	this._lock.loadWhenEqual(0);
}

IntQueue.prototype._release = function () {
    this._lock.store(0);
}
