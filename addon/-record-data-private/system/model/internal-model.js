import { A } from '@ember/array';
import { set, get } from '@ember/object';
import EmberError from '@ember/error';
import { setOwner } from '@ember/application';
import { run } from '@ember/runloop';
import RSVP, { Promise } from 'rsvp';
import Ember from 'ember';
import { DEBUG } from '@glimmer/env';
import { assert, inspect } from '@ember/debug';
import RootState from './states';
import Snapshot from '../snapshot';
import OrderedSet from '../ordered-set';
import isArrayLike from '../is-array-like';
import ManyArray from '../many-array';
import { PromiseBelongsTo, PromiseManyArray } from '../promise-proxies';
import { getOwner } from '../../utils';

import { RecordReference, BelongsToReference, HasManyReference } from '../references';

/*
  The TransitionChainMap caches the `state.enters`, `state.setups`, and final state reached
  when transitioning from one state to another, so that future transitions can replay the
  transition without needing to walk the state tree, collect these hook calls and determine
   the state to transition into.

   A future optimization would be to build a single chained method out of the collected enters
   and setups. It may also be faster to do a two level cache (from: { to }) instead of caching based
   on a key that adds the two together.
 */
const TransitionChainMap = Object.create(null);

const _extractPivotNameCache = Object.create(null);
const _splitOnDotCache = Object.create(null);

function splitOnDot(name) {
  return _splitOnDotCache[name] || (_splitOnDotCache[name] = name.split('.'));
}

function extractPivotName(name) {
  return _extractPivotNameCache[name] || (_extractPivotNameCache[name] = splitOnDot(name)[0]);
}

// this (and all heimdall instrumentation) will be stripped by a babel transform
//  https://github.com/heimdalljs/babel5-plugin-strip-heimdall
const {
  _triggerDeferredTriggers,
  changedAttributes,
  createSnapshot,
  hasChangedAttributes,
  materializeRecord,
  new_InternalModel,
  send,
  setupData,
  transitionTo,
} = heimdall.registerMonitor(
  'InternalModel',
  '_triggerDeferredTriggers',
  'changedAttributes',
  'createSnapshot',
  'hasChangedAttributes',
  'materializeRecord',
  'new_InternalModel',
  'send',
  'setupData',
  'transitionTo'
);

let InternalModelReferenceId = 1;

/*
  `InternalModel` is the Model class that we use internally inside Ember Data to represent models.
  Internal ED methods should only deal with `InternalModel` objects. It is a fast, plain Javascript class.

  We expose `DS.Model` to application code, by materializing a `DS.Model` from `InternalModel` lazily, as
  a performance optimization.

  `InternalModel` should never be exposed to application code. At the boundaries of the system, in places
  like `find`, `push`, etc. we convert between Models and InternalModels.

  We need to make sure that the properties from `InternalModel` are correctly exposed/proxied on `Model`
  if they are needed.

  @private
  @class InternalModel
*/
export default class InternalModel {
  constructor(modelName, id, store, data, clientId) {
    heimdall.increment(new_InternalModel);
    this.id = id;
    this.store = store;
    this.modelName = modelName;
    this.clientId = clientId;

    this._modelData = store._createModelData(modelName, id, clientId, this);

    // this ensure ordered set can quickly identify this as unique
    this[Ember.GUID_KEY] = InternalModelReferenceId++ + 'internal-model';

    this._loadingPromise = null;
    this._record = null;
    this._isDestroyed = false;
    this.isError = false;
    this._pendingRecordArrayManagerFlush = false; // used by the recordArrayManager

    // During dematerialization we don't want to rematerialize the record.  The
    // reason this might happen is that dematerialization removes records from
    // record arrays,  and Ember arrays will always `objectAt(0)` and
    // `objectAt(len - 1)` to test whether or not `firstObject` or `lastObject`
    // have changed.
    this._isDematerializing = false;
    this._scheduledDestroy = null;

    this.resetRecord();

    // caches for lazy getters
    this._modelClass = null;
    this.__deferredTriggers = null;
    this.__recordArrays = null;
    this._references = null;
    this._recordReference = null;

    this._manyArrayCache = Object.create(null);
    this._retainedManyArrayCache = Object.create(null);
    this._relationshipPromisesCache = Object.create(null);
  }

  get modelClass() {
    return this._modelClass || (this._modelClass = this.store.modelFor(this.modelName));
  }

  get type() {
    return this.modelClass;
  }

  get recordReference() {
    if (this._recordReference === null) {
      this._recordReference = new RecordReference(this.store, this);
    }
    return this._recordReference;
  }

  get _recordArrays() {
    if (this.__recordArrays === null) {
      this.__recordArrays = OrderedSet.create();
    }
    return this.__recordArrays;
  }

  get references() {
    if (this._references === null) {
      this._references = Object.create(null);
    }
    return this._references;
  }

  get _deferredTriggers() {
    if (this.__deferredTriggers === null) {
      this.__deferredTriggers = [];
    }
    return this.__deferredTriggers;
  }

  isHiddenFromRecordArrays() {
    // During dematerialization we don't want to rematerialize the record.
    // recordWasDeleted can cause other records to rematerialize because it
    // removes the internal model from the array and Ember arrays will always
    // `objectAt(0)` and `objectAt(len -1)` to check whether `firstObject` or
    // `lastObject` have changed.  When this happens we don't want those
    // models to rematerialize their records.

    return (
      this._isDematerializing ||
      this.hasScheduledDestroy() ||
      this.isDestroyed ||
      this.currentState.stateName === 'root.deleted.saved' ||
      this.isEmpty()
    );
  }

  isRecordInUse() {
    let record = this._record;
    return record && !(record.get('isDestroyed') || record.get('isDestroying'));
  }

  isEmpty() {
    return this.currentState.isEmpty;
  }

  isLoading() {
    return this.currentState.isLoading;
  }

  isLoaded() {
    return this.currentState.isLoaded;
  }

  hasDirtyAttributes() {
    return this.currentState.hasDirtyAttributes;
  }

  isSaving() {
    return this.currentState.isSaving;
  }

  isDeleted() {
    return this.currentState.isDeleted;
  }

  isNew() {
    return this.currentState.isNew;
  }

  isValid() {
    return this.currentState.isValid;
  }

  dirtyType() {
    return this.currentState.dirtyType;
  }

  // DO NOT USE : purely to ease the transition in tests
  get _attributes() {
    return this._modelData._attributes;
  }

  // DO NOT USE : purely to ease the transition in tests
  get _relationships() {
    return this._modelData._relationships;
  }

  getRecord(properties) {
    if (!this._record && !this._isDematerializing) {
      heimdall.increment(materializeRecord);
      let token = heimdall.start('InternalModel.getRecord');

      // lookupFactory should really return an object that creates
      // instances with the injections applied
      let createOptions = {
        store: this.store,
        _internalModel: this,
        currentState: this.currentState,
        isError: this.isError,
        adapterError: this.error,
      };

      if (properties !== undefined) {
        assert(
          `You passed '${properties}' as properties for record creation instead of an object.`,
          typeof properties === 'object' && properties !== null
        );
        let classFields = this.getFields();
        // TODO disentangle post-rebase
        let relationships = this._modelData._relationships;
        let propertyNames = Object.keys(properties);

        for (let i = 0; i < propertyNames.length; i++) {
          let name = propertyNames[i];
          let fieldType = classFields.get(name);
          let propertyValue = properties[name];

          if (name === 'id') {
            this.setId(propertyValue);
            continue;
          }

          switch (fieldType) {
            case 'attribute':
              this.setDirtyAttribute(name, propertyValue);
              break;
            case 'belongsTo':
              this.setDirtyBelongsTo(name, propertyValue);
              relationships.get(name).setHasAnyRelationshipData(true);
              relationships.get(name).setRelationshipIsEmpty(false);
              break;
            case 'hasMany':
              this.setDirtyHasMany(name, propertyValue);
              relationships.get(name).setHasAnyRelationshipData(true);
              relationships.get(name).setRelationshipIsEmpty(false);
              break;
            default:
              createOptions[name] = propertyValue;
          }
        }
      }

      if (setOwner) {
        // ensure that `getOwner(this)` works inside a model instance
        setOwner(createOptions, getOwner(this.store));
      } else {
        createOptions.container = this.store.container;
      }

      this._record = this.store._modelFactoryFor(this.modelName).create(createOptions);

      this._triggerDeferredTriggers();
      heimdall.stop(token);
    }

    return this._record;
  }

  getFields() {
    return get(this.modelClass, 'fields');
  }

  resetRecord() {
    this._record = null;
    this.isReloading = false;
    this.error = null;
    this.currentState = RootState.empty;
  }

  dematerializeRecord() {
    this._isDematerializing = true;

    // TODO IGOR add a test that fails when this is missing, something that involves canceliing a destroy
    // and the destroy not happening, and then later on trying to destroy
    this._doNotDestroy = false;

    if (this._record) {
      Object.keys(this._relationshipPromisesCache).forEach(key => {
        // TODO Igor cleanup the guard
        // TODO there is probably relationship cleanup to do outside of the _record check
        if (this._relationshipPromisesCache[key].destroy) {
          this._relationshipPromisesCache[key].destroy();
        }
        delete this._relationshipPromisesCache[key];
      });
      Object.keys(this._manyArrayCache).forEach(key => {
        this._retainedManyArrayCache[key] = this._manyArrayCache[key];
        delete this._manyArrayCache[key];
      });
      this._record.destroy();
    }

    // move to an empty never-loaded state
    this.resetRecord();
    this._modelData.unloadRecord();
    this.updateRecordArrays();
  }

  deleteRecord() {
    this.send('deleteRecord');
  }

  save(options) {
    let promiseLabel = 'DS: Model#save ' + this;
    let resolver = RSVP.defer(promiseLabel);

    this.store.scheduleSave(this, resolver, options);
    return resolver.promise;
  }

  startedReloading() {
    this.isReloading = true;
    if (this.hasRecord) {
      set(this._record, 'isReloading', true);
    }
  }

  linkWasLoadedForRelationship(key, data) {
    let relationships = {};
    relationships[key] = data;
    this._modelData.pushData({ id: this.id, type: this.modelName, relationships });
  }

  finishedReloading() {
    this.isReloading = false;
    if (this.hasRecord) {
      set(this._record, 'isReloading', false);
    }
  }

  reload(options) {
    this.startedReloading();
    let internalModel = this;
    let promiseLabel = 'DS: Model#reload of ' + this;

    return new Promise(function(resolve) {
      internalModel.send('reloadRecord', { resolve, options });
    }, promiseLabel)
      .then(
        function() {
          internalModel.didCleanError();
          return internalModel;
        },
        function(error) {
          internalModel.didError(error);
          throw error;
        },
        'DS: Model#reload complete, update flags'
      )
      .finally(function() {
        internalModel.finishedReloading();
        internalModel.updateRecordArrays();
      });
  }

  /*
    Unload the record for this internal model. This will cause the record to be
    destroyed and freed up for garbage collection. It will also do a check
    for cleaning up internal models.

    This check is performed by first computing the set of related internal
    models. If all records in this set are unloaded, then the entire set is
    destroyed. Otherwise, nothing in the set is destroyed.

    This means that this internal model will be freed up for garbage collection
    once all models that refer to it via some relationship are also unloaded.
  */
  unloadRecord() {
    if (this.isDestroyed) {
      return;
    }
    this.send('unloadRecord');
    this.dematerializeRecord();
    if (this._scheduledDestroy === null) {
      // TODO: use run.schedule once we drop 1.13
      if (!run.currentRunLoop) {
        assert(
          "You have turned on testing mode, which disabled the run-loop's autorun.\n                  You will need to wrap any code with asynchronous side-effects in a run",
          Ember.testing
        );
      }
      this._scheduledDestroy = run.backburner.schedule(
        'destroy',
        this,
        '_checkForOrphanedInternalModels'
      );
    }
  }

  hasScheduledDestroy() {
    return !!this._scheduledDestroy;
  }

  cancelDestroy() {
    assert(
      `You cannot cancel the destruction of an InternalModel once it has already been destroyed`,
      !this.isDestroyed
    );

    this._doNotDestroy = true;
    this._isDematerializing = false;
    run.cancel(this._scheduledDestroy);
    this._scheduledDestroy = null;
  }

  // typically, we prefer to async destroy this lets us batch cleanup work.
  // Unfortunately, some scenarios where that is not possible. Such as:
  //
  // ```js
  // const record = store.find(‘record’, 1);
  // record.unloadRecord();
  // store.createRecord(‘record’, 1);
  // ```
  //
  // In those scenarios, we make that model's cleanup work, sync.
  //
  destroySync() {
    if (this._isDematerializing) {
      this.cancelDestroy();
    }
    this._checkForOrphanedInternalModels();
    if (this.isDestroyed || this.isDestroying) {
      return;
    }

    // just in-case we are not one of the orphaned, we should still
    // still destroy ourselves
    this.destroy();
  }

  _checkForOrphanedInternalModels() {
    this._isDematerializing = false;
    this._scheduledDestroy = null;
    if (this.isDestroyed) {
      return;
    }
  }

  eachRelationship(callback, binding) {
    return this.modelClass.eachRelationship(callback, binding);
  }

  getBelongsTo(key) {
    let resource = this._modelData.getBelongsTo(key);
    let relationshipMeta = this.store._relationshipMetaFor(this.modelName, null, key);
    let store = this.store;
    let parentInternalModel = this;
    let async = relationshipMeta.options.async;
    let isAsync = typeof async === 'undefined' ? true : async;

    if (isAsync) {
      let internalModel =
        resource && resource.data ? store._internalModelForResource(resource.data) : null;
      return PromiseBelongsTo.create({
        _belongsToState: resource._relationship,
        promise: store._findBelongsToByJsonApiResource(
          resource,
          parentInternalModel,
          relationshipMeta
        ),
        content: internalModel ? internalModel.getRecord() : null,
      });
    } else {
      if (!resource || !resource.data) {
        return null;
      } else {
        let internalModel = store._internalModelForResource(resource.data);
        let toReturn = internalModel.getRecord();
        assert(
          "You looked up the '" +
            key +
            "' relationship on a '" +
            parentInternalModel.modelName +
            "' with id " +
            parentInternalModel.id +
            ' but some of the associated records were not loaded. Either make sure they are all loaded together with the parent record, or specify that the relationship is async (`DS.belongsTo({ async: true })`)',
          toReturn === null || !toReturn.get('isEmpty')
        );
        return toReturn;
      }
    }
  }

  // TODO Igor consider getting rid of initial state
  getManyArray(key) {
    let relationshipMeta = this.store._relationshipMetaFor(this.modelName, null, key);
    let jsonApi = this._modelData.getHasMany(key);
    let manyArray = this._manyArrayCache[key];

    assert(
      `Error: relationship ${this.modelName}:${key} has both many array and retained many array`,
      !manyArray || !this._retainedManyArrayCache[key]
    );

    if (!manyArray) {
      let initialState = this.store._getHasManyByJsonApiResource(jsonApi);

      manyArray = ManyArray.create({
        store: this.store,
        type: this.store.modelFor(relationshipMeta.type),
        modelData: this._modelData,
        meta: jsonApi.meta,
        key,
        isPolymorphic: relationshipMeta.options.polymorphic,
        initialState: initialState.slice(),
        internalModel: this,
      });
      this._manyArrayCache[key] = manyArray;
    }

    if (this._retainedManyArrayCache[key]) {
      this._retainedManyArrayCache[key].destroy();
      delete this._retainedManyArrayCache[key];
    }

    return manyArray;
  }

  fetchAsyncHasMany(relationshipMeta, jsonApi, manyArray) {
    let promise = this.store._findHasManyByJsonApiResource(jsonApi, this, relationshipMeta);
    promise = promise.then(initialState => {
      // TODO why don't we do this in the store method
      manyArray.retrieveLatest();
      manyArray.set('isLoaded', true);

      return manyArray;
    });
    return promise;
  }

  getHasMany(key) {
    let jsonApi = this._modelData.getHasMany(key);
    let relationshipMeta = this.store._relationshipMetaFor(this.modelName, null, key);
    let async = relationshipMeta.options.async;
    let isAsync = typeof async === 'undefined' ? true : async;
    let manyArray = this.getManyArray(key);

    if (isAsync) {
      let promiseArray = this._relationshipPromisesCache[key];

      if (!promiseArray) {
        promiseArray = PromiseManyArray.create({
          promise: this.fetchAsyncHasMany(relationshipMeta, jsonApi, manyArray),
          content: manyArray,
        });
        this._relationshipPromisesCache[key] = promiseArray;
      }

      return promiseArray;
    } else {
      manyArray.set('isLoaded', true);
      assert(
        `You looked up the '${key}' relationship on a '${this.type.modelName}' with id ${
          this.id
        } but some of the associated records were not loaded. Either make sure they are all loaded together with the parent record, or specify that the relationship is async ('DS.hasMany({ async: true })')`,
        !manyArray.anyUnloaded()
      );

      return manyArray;
    }
  }

  _updateLoadingPromiseForHasMany(key, promise, content) {
    let loadingPromise = this._relationshipPromisesCache[key];
    if (loadingPromise) {
      if (content) {
        loadingPromise.set('content', content);
      }
      loadingPromise.set('promise', promise);
    } else {
      this._relationshipPromisesCache[key] = PromiseManyArray.create({
        promise,
        content,
      });
    }

    return this._relationshipPromisesCache[key];
  }

  reloadHasMany(key) {
    let loadingPromise = this._relationshipPromisesCache[key];
    if (loadingPromise) {
      if (loadingPromise.get('isPending')) {
        return loadingPromise;
      }
      /* TODO Igor check wtf this is about
      if (loadingPromise.get('isRejected')) {
        manyArray.set('isLoaded', manyArrayLoadedState);
      }
      */
    }

    let jsonApi = this._modelData.getHasMany(key);
    jsonApi._relationship.setRelationshipIsStale(true);
    let relationshipMeta = this.store._relationshipMetaFor(this.modelName, null, key);
    let manyArray = this.getManyArray(key);
    let promise = this.fetchAsyncHasMany(relationshipMeta, jsonApi, manyArray);

    // TODO igor Seems like this would mess with promiseArray wrapping, investigate
    this._updateLoadingPromiseForHasMany(key, promise);
    return promise;
  }

  reloadBelongsTo(key) {
    let resource = this._modelData.getBelongsTo(key);
    resource._relationship.setRelationshipIsStale(true);
    let relationshipMeta = this.store._relationshipMetaFor(this.modelName, null, key);

    return this.store._findBelongsToByJsonApiResource(resource, this, relationshipMeta);
  }

  destroyFromModelData() {
    if (this._doNotDestroy) {
      this._doNotDestroy = false;
      return;
    }
    this.destroy();
  }

  destroy() {
    assert(
      'Cannot destroy an internalModel while its record is materialized',
      !this._record || this._record.get('isDestroyed') || this._record.get('isDestroying')
    );
    this.isDestroying = true;
    Object.keys(this._retainedManyArrayCache).forEach(key => {
      this._retainedManyArrayCache[key].destroy();
      delete this._retainedManyArrayCache[key];
    });

    this.store._removeFromIdMap(this);
    this._isDestroyed = true;
  }

  eachAttribute(callback, binding) {
    return this.modelClass.eachAttribute(callback, binding);
  }

  inverseFor(key) {
    return this.modelClass.inverseFor(key);
  }

  setupData(data) {
    heimdall.increment(setupData);
    let changedKeys = this._modelData.pushData(data, this.hasRecord);
    if (this.hasRecord) {
      this._record._notifyProperties(changedKeys);
    }
    this.pushedData();
  }

  getAttributeValue(key) {
    return this._modelData.getAttr(key);
  }

  setDirtyHasMany(key, records) {
    assert(`You must pass an array of records to set a hasMany relationship`, isArrayLike(records));
    assert(
      `All elements of a hasMany relationship must be instances of DS.Model, you passed ${inspect(
        records
      )}`,
      (function() {
        return A(records).every(record => record.hasOwnProperty('_internalModel') === true);
      })()
    );

    // TODO this seems like unnecessary churn
    this._modelData.setDirtyHasMany(
      key,
      records.map(record => record.get('_internalModel._modelData').getResourceIdentifier())
    );
  }

  setDirtyBelongsTo(key, value) {
    // TODO this seems like a digression from the pattern in setDirtyHasMany
    return this._modelData.setDirtyBelongsTo(key, value);
  }

  setDirtyAttribute(key, value) {
    if (this.isDeleted()) {
      throw new EmberError(`Attempted to set '${key}' to '${value}' on the deleted record ${this}`);
    }

    let currentValue = this.getAttributeValue(key);
    if (currentValue !== value) {
      this._modelData.setDirtyAttribute(key, value);
      let isDirty = this._modelData.isAttrDirty(key);
      this.send('didSetProperty', {
        name: key,
        isDirty: isDirty,
      });
    }

    return value;
  }

  get isDestroyed() {
    return this._isDestroyed;
  }

  get hasRecord() {
    return !!this._record;
  }

  /*
    @method createSnapshot
    @private
  */
  createSnapshot(options) {
    heimdall.increment(createSnapshot);
    return new Snapshot(this, options);
  }

  /*
    @method loadingData
    @private
    @param {Promise} promise
  */
  loadingData(promise) {
    this.send('loadingData', promise);
  }

  /*
    @method loadedData
    @private
  */
  loadedData() {
    this.send('loadedData');
  }

  /*
    @method notFound
    @private
  */
  notFound() {
    this.send('notFound');
  }

  /*
    @method pushedData
    @private
  */
  pushedData() {
    this.send('pushedData');
  }

  hasChangedAttributes() {
    heimdall.increment(hasChangedAttributes);
    return this._modelData.hasChangedAttributes();
  }

  /*
    Returns an object, whose keys are changed properties, and value is an
    [oldProp, newProp] array.

    @method changedAttributes
    @private
  */
  changedAttributes() {
    heimdall.increment(changedAttributes);
    return this._modelData.changedAttributes();
  }

  /*
    @method adapterWillCommit
    @private
  */
  adapterWillCommit() {
    this._modelData.willCommit();
    this.send('willCommit');
  }

  /*
    @method adapterDidDirty
    @private
  */
  adapterDidDirty() {
    this.send('becomeDirty');
    this.updateRecordArrays();
  }

  /*
    @method send
    @private
    @param {String} name
    @param {Object} context
  */
  send(name, context) {
    heimdall.increment(send);
    let currentState = this.currentState;

    if (!currentState[name]) {
      this._unhandledEvent(currentState, name, context);
    }

    return currentState[name](this, context);
  }

  manyArrayRecordAdded(key) {
    if (this.hasRecord) {
      this._record.notifyHasManyAdded(key);
    }
  }

  notifyHasManyChange(key, record, idx) {
    if (this.hasRecord) {
      let manyArray = this._manyArrayCache[key];
      if (manyArray) {
        // TODO: this will "resurrect" previously unloaded records
        // see test '1:many async unload many side'
        //  in `tests/integration/records/unload-test.js`
        //  probably we don't want to retrieve latest eagerly when notifyhasmany changed
        //  but rather lazily when someone actually asks for a manyarray
        //
        //  that said, also not clear why we haven't moved this to retainedmanyarray so maybe that's the bit that's just not workign
        manyArray.retrieveLatest();
        // TODO Igor be rigorous about when to delete this
        // TODO: igor check for case where we later unload again
        if (this._relationshipPromisesCache[key] && manyArray.anyUnloaded()) {
          delete this._relationshipPromisesCache[key];
        }
      }
      this.updateRecordArrays();
    }
  }

  notifyBelongsToChange(key, record) {
    if (this.hasRecord) {
      this._record.notifyBelongsToChanged(key, record);
      this.updateRecordArrays();
    }
  }

  notifyPropertyChange(key) {
    if (this.hasRecord) {
      this._record.notifyPropertyChange(key);
      this.updateRecordArrays();
    }
    let manyArray = this._manyArrayCache[key] || this._retainedManyArrayCache[key];
    if (manyArray) {
      let didRemoveUnloadedModel = manyArray.removeUnloadedInternalModel();
      if (this._manyArrayCache[key] && didRemoveUnloadedModel) {
        this._retainedManyArrayCache[key] = this._manyArrayCache[key];
        delete this._manyArrayCache[key];
      }
    }
    if (this._relationshipPromisesCache[key]) {
      this._relationshipPromisesCache[key].destroy();
      delete this._relationshipPromisesCache[key];
    }
  }

  didCreateRecord() {
    this._modelData.clientDidCreate();
  }

  rollbackAttributes() {
    let dirtyKeys = this._modelData.rollbackAttributes();
    if (get(this, 'isError')) {
      this.didCleanError();
    }

    this.send('rolledBack');

    if (this._record && dirtyKeys && dirtyKeys.length > 0) {
      this._record._notifyProperties(dirtyKeys);
    }
  }

  /*
    @method transitionTo
    @private
    @param {String} name
  */
  transitionTo(name) {
    heimdall.increment(transitionTo);
    // POSSIBLE TODO: Remove this code and replace with
    // always having direct reference to state objects

    let pivotName = extractPivotName(name);
    let state = this.currentState;
    let transitionMapId = `${state.stateName}->${name}`;

    do {
      if (state.exit) {
        state.exit(this);
      }
      state = state.parentState;
    } while (!state[pivotName]);

    let setups;
    let enters;
    let i;
    let l;
    let map = TransitionChainMap[transitionMapId];

    if (map) {
      setups = map.setups;
      enters = map.enters;
      state = map.state;
    } else {
      setups = [];
      enters = [];

      let path = splitOnDot(name);

      for (i = 0, l = path.length; i < l; i++) {
        state = state[path[i]];

        if (state.enter) {
          enters.push(state);
        }
        if (state.setup) {
          setups.push(state);
        }
      }

      TransitionChainMap[transitionMapId] = { setups, enters, state };
    }

    for (i = 0, l = enters.length; i < l; i++) {
      enters[i].enter(this);
    }

    this.currentState = state;
    if (this.hasRecord) {
      set(this._record, 'currentState', state);
    }

    for (i = 0, l = setups.length; i < l; i++) {
      setups[i].setup(this);
    }

    this.updateRecordArrays();
  }

  _unhandledEvent(state, name, context) {
    let errorMessage = 'Attempted to handle event `' + name + '` ';
    errorMessage += 'on ' + String(this) + ' while in state ';
    errorMessage += state.stateName + '. ';

    if (context !== undefined) {
      errorMessage += 'Called with ' + inspect(context) + '.';
    }

    throw new EmberError(errorMessage);
  }

  triggerLater(...args) {
    if (this._deferredTriggers.push(args) !== 1) {
      return;
    }

    this.store._updateInternalModel(this);
  }

  _triggerDeferredTriggers() {
    heimdall.increment(_triggerDeferredTriggers);
    //TODO: Before 1.0 we want to remove all the events that happen on the pre materialized record,
    //but for now, we queue up all the events triggered before the record was materialized, and flush
    //them once we have the record
    if (!this.hasRecord) {
      return;
    }
    let triggers = this._deferredTriggers;
    let record = this._record;
    let trigger = record.trigger;
    for (let i = 0, l = triggers.length; i < l; i++) {
      trigger.apply(record, triggers[i]);
    }

    triggers.length = 0;
  }

  removeFromInverseRelationships(isNew = false) {
    this._modelData.removeFromInverseRelationships(isNew);
  }

  /*
    When a find request is triggered on the store, the user can optionally pass in
    attributes and relationships to be preloaded. These are meant to behave as if they
    came back from the server, except the user obtained them out of band and is informing
    the store of their existence. The most common use case is for supporting client side
    nested URLs, such as `/posts/1/comments/2` so the user can do
    `store.findRecord('comment', 2, { preload: { post: 1 } })` without having to fetch the post.

    Preloaded data can be attributes and relationships passed in either as IDs or as actual
    models.

    @method preloadData
    @private
    @param {Object} preload
  */
  preloadData(preload) {
    let jsonPayload = {};
    //TODO(Igor) consider the polymorphic case
    Object.keys(preload).forEach(key => {
      let preloadValue = get(preload, key);
      let relationshipMeta = this.modelClass.metaForProperty(key);
      if (relationshipMeta.isRelationship) {
        if (!jsonPayload.relationships) {
          jsonPayload.relationships = {};
        }
        jsonPayload.relationships[key] = this._preloadRelationship(key, preloadValue);
      } else {
        if (!jsonPayload.attributes) {
          jsonPayload.attributes = {};
        }
        jsonPayload.attributes[key] = preloadValue;
      }
    });
    this._modelData.pushData(jsonPayload);
  }

  _preloadRelationship(key, preloadValue) {
    let relationshipMeta = this.modelClass.metaForProperty(key);
    let modelClass = relationshipMeta.type;
    let data;
    if (relationshipMeta.kind === 'hasMany') {
      assert(
        'You need to pass in an array to set a hasMany property on a record',
        Array.isArray(preloadValue)
      );
      data = preloadValue.map(value => this._convertPreloadRelationshipToJSON(value, modelClass));
    } else {
      data = this._convertPreloadRelationshipToJSON(preloadValue, modelClass);
    }
    return { data };
  }

  _convertPreloadRelationshipToJSON(value, modelClass) {
    if (typeof value === 'string' || typeof value === 'number') {
      return { type: modelClass, id: value };
    }
    let internalModel;
    if (value._internalModel) {
      internalModel = value._internalModel;
    } else {
      internalModel = value;
    }
    // TODO IGOR DAVID assert if no id is present
    return { type: internalModel.modelName, id: internalModel.id };
  }

  /*
    Used to notify the store to update FilteredRecordArray membership.

    @method updateRecordArrays
    @private
  */
  updateRecordArrays() {
    this.store.recordArrayManager.recordDidChange(this);
  }

  setId(id) {
    assert(
      "A record's id cannot be changed once it is in the loaded state",
      this.id === null || this.id === id || this.isNew()
    );
    let didChange = id !== this.id;
    this.id = id;

    if (didChange && this.hasRecord) {
      this._record.notifyPropertyChange('id');
    }
  }

  didError(error) {
    this.error = error;
    this.isError = true;

    if (this.hasRecord) {
      this._record.setProperties({
        isError: true,
        adapterError: error,
      });
    }
  }

  didCleanError() {
    this.error = null;
    this.isError = false;

    if (this.hasRecord) {
      this._record.setProperties({
        isError: false,
        adapterError: null,
      });
    }
  }

  /*
    If the adapter did not return a hash in response to a commit,
    merge the changed attributes and relationships into the existing
    saved data.

    @method adapterDidCommit
  */
  adapterDidCommit(data) {
    this.didCleanError();

    let changedKeys = this._modelData.didCommit(data);

    this.send('didCommit');
    this.updateRecordArrays();

    if (!data) {
      return;
    }

    this._record._notifyProperties(changedKeys);
  }

  addErrorMessageToAttribute(attribute, message) {
    get(this.getRecord(), 'errors')._add(attribute, message);
  }

  removeErrorMessageFromAttribute(attribute) {
    get(this.getRecord(), 'errors')._remove(attribute);
  }

  clearErrorMessages() {
    get(this.getRecord(), 'errors')._clear();
  }

  hasErrors() {
    let errors = get(this.getRecord(), 'errors');

    return errors.get('length') > 0;
  }

  // FOR USE DURING COMMIT PROCESS

  /*
    @method adapterDidInvalidate
    @private
  */
  adapterDidInvalidate(errors) {
    let attribute;

    for (attribute in errors) {
      if (errors.hasOwnProperty(attribute)) {
        this.addErrorMessageToAttribute(attribute, errors[attribute]);
      }
    }

    this.send('becameInvalid');

    this._modelData.commitWasRejected();
  }

  /*
    @method adapterDidError
    @private
  */
  adapterDidError(error) {
    this.send('becameError');
    this.didError(error);

    this._modelData.commitWasRejected();
  }

  toString() {
    return `<${this.modelName}:${this.id}>`;
  }

  referenceFor(kind, name) {
    let reference = this.references[name];

    if (!reference) {
      // TODO IGOR AND DAVID REFACTOR
      let relationship = this._modelData._relationships.get(name);

      if (DEBUG) {
        let modelName = this.modelName;
        assert(
          `There is no ${kind} relationship named '${name}' on a model of modelClass '${modelName}'`,
          relationship
        );

        let actualRelationshipKind = relationship.relationshipMeta.kind;
        assert(
          `You tried to get the '${name}' relationship on a '${modelName}' via record.${kind}('${name}'), but the relationship is of kind '${actualRelationshipKind}'. Use record.${actualRelationshipKind}('${name}') instead.`,
          actualRelationshipKind === kind
        );
      }

      if (kind === 'belongsTo') {
        reference = new BelongsToReference(this.store, this, relationship, name);
      } else if (kind === 'hasMany') {
        reference = new HasManyReference(this.store, this, relationship, name);
      }

      this.references[name] = reference;
    }

    return reference;
  }
}
