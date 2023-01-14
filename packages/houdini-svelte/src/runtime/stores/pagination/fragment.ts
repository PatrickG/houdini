import { DocumentObserver } from '$houdini/runtime/client/documentObserver'
import { keyFieldsForType, getCurrentConfig } from '$houdini/runtime/lib/config'
import { siteURL } from '$houdini/runtime/lib/constants'
import { getCurrentClient } from '$houdini/runtime/lib/network'
import {
	GraphQLObject,
	FragmentArtifact,
	QueryArtifact,
	HoudiniFetchContext,
	CompiledFragmentKind,
} from '$houdini/runtime/lib/types'
import { derived, get, Readable, Subscriber, Writable, writable } from 'svelte/store'

import { StoreConfig } from '../query'
import { cursorHandlers, CursorHandlers } from './cursor'
import { offsetHandlers } from './offset'
import { nullPageInfo, PageInfo } from './pageInfo'

type FragmentStoreConfig<_Data extends GraphQLObject, _Input> = StoreConfig<
	_Data,
	_Input,
	FragmentArtifact
> & { paginationArtifact: QueryArtifact }

class BasePaginatedFragmentStore<_Data extends GraphQLObject, _Input> {
	// all paginated stores need to have a flag to distinguish from other fragment stores
	paginated = true

	protected paginationArtifact: QueryArtifact
	name: string
	kind = CompiledFragmentKind

	constructor(config: FragmentStoreConfig<_Data, _Input>) {
		this.paginationArtifact = config.paginationArtifact
		this.name = config.storeName
	}

	protected async queryVariables(
		store: Readable<FragmentPaginatedResult<_Data, unknown>>
	): Promise<_Input> {
		const config = getCurrentConfig()

		const { targetType } = this.paginationArtifact.refetch || {}
		const typeConfig = config.types?.[targetType || '']
		if (!typeConfig) {
			throw new Error(
				`Missing type refetch configuration for ${targetType}. For more information, see ${siteURL}/guides/pagination#paginated-fragments`
			)
		}

		// if we have a specific function to use when computing the variables
		// then we need to collect those fields
		let idVariables = {}
		const value = get(store).data
		if (typeConfig.resolve?.arguments) {
			// @ts-ignore
			idVariables = (typeConfig.resolve!.arguments?.(value) || {}) as _Input
		} else {
			const keys = keyFieldsForType(config, targetType || '')
			// @ts-ignore
			idVariables = Object.fromEntries(keys.map((key) => [key, value[key]])) as _Input
		}

		// add the id variables to the query variables
		return {
			...idVariables,
		} as _Input
	}
}

// both cursor paginated stores add a page info to their subscribe
class FragmentStoreCursor<
	_Data extends GraphQLObject,
	_Input extends Record<string, any>
> extends BasePaginatedFragmentStore<_Data, _Input> {
	// we want to add the cursor-based fetch to the return value of get
	get(initialValue: _Data | null) {
		const store = getCurrentClient().observe<_Data, _Input>({
			artifact: this.paginationArtifact,
			initialValue: initialValue ?? null,
		})

		// track the loading state
		const loading = writable(false)

		// generate the pagination handlers
		const handlers = this.storeHandlers(store)

		const subscribe = (
			run: Subscriber<FragmentPaginatedResult<_Data, { pageInfo: PageInfo }>>,
			invalidate?:
				| ((
						value?: FragmentPaginatedResult<_Data, { pageInfo: PageInfo }> | undefined
				  ) => void)
				| undefined
		): (() => void) => {
			const combined = derived(
				[store, handlers.pageInfo],
				([$parent, $pageInfo]) =>
					({
						...$parent,
						pageInfo: $pageInfo,
					} as FragmentPaginatedResult<_Data, { pageInfo: PageInfo }>)
			)

			return combined.subscribe(run, invalidate)
		}

		return {
			kind: CompiledFragmentKind,
			data: derived(store, ($value) => $value.data),
			subscribe: subscribe,
			loading: loading as Readable<boolean>,
			fetch: handlers.fetch,
			pageInfo: handlers.pageInfo,
		}
	}

	protected storeHandlers(
		observer: DocumentObserver<_Data, _Input>
	): CursorHandlers<_Data, _Input> {
		return cursorHandlers<_Data, _Input>({
			artifact: this.paginationArtifact,
			fetchUpdate: async (args) => {
				return observer.send({
					...args,
					variables: {
						...args?.variables,
						...this.queryVariables(observer),
					},
					cacheParams: {
						applyUpdates: true,
					},
				})
			},
			fetch: async (args) => {
				return observer.send({
					...args,
					variables: {
						...args?.variables,
						...this.queryVariables(observer),
					},
				})
			},
			observer,
			storeName: this.name,
		})
	}
}

// FragmentStoreForwardCursor adds loadNextPage to FragmentStoreCursor
export class FragmentStoreForwardCursor<
	_Data extends GraphQLObject,
	_Input extends Record<string, any>
> extends FragmentStoreCursor<_Data, _Input> {
	get(initialValue: _Data | null) {
		// get the base class
		const parent = super.get(initialValue)
		const observer = getCurrentClient().observe<_Data, _Input>({
			artifact: this.paginationArtifact,
			initialValue,
		})

		// generate the pagination handlers
		const handlers = this.storeHandlers(observer)

		return {
			...parent,
			// add the specific handlers for this situation
			loadNextPage: handlers.loadNextPage,
		}
	}
}

// BackwardFragmentStoreCursor adds loadPreviousPage to FragmentStoreCursor
export class FragmentStoreBackwardCursor<
	_Data extends GraphQLObject,
	_Input extends Record<string, any>
> extends FragmentStoreCursor<_Data, _Input> {
	get(initialValue: _Data | null) {
		const parent = super.get(initialValue)
		const observer = getCurrentClient().observe<_Data, _Input>({
			artifact: this.paginationArtifact,
			initialValue,
		})

		// generate the pagination handlers
		const handlers = this.storeHandlers(observer)

		return {
			...parent,
			// add the specific handlers for this situation
			loadPreviousPage: handlers.loadPreviousPage,
		}
	}
}

export class FragmentStoreOffset<
	_Data extends GraphQLObject,
	_Input extends Record<string, any>
> extends BasePaginatedFragmentStore<_Data, _Input> {
	get(initialValue: _Data | null) {
		const observer = getCurrentClient().observe<_Data, _Input>({
			artifact: this.paginationArtifact,
			initialValue,
		})

		// create the offset handlers we'll add to the store
		const handlers = offsetHandlers<_Data, _Input>({
			artifact: this.paginationArtifact,
			fetch: async (args) => {
				return observer.send({
					...args,
					variables: {
						...args?.variables,
						...this.queryVariables(observer),
					},
				})
			},
			fetchUpdate: async (args) => {
				return observer.send({
					...args,
					variables: {
						...args?.variables,
						...this.queryVariables(observer),
					},
					cacheParams: {
						applyUpdates: true,
					},
				})
			},
			observer,
			storeName: this.name,
		})

		// add the offset handlers
		return {
			...observer,
			kind: CompiledFragmentKind,
			fetch: handlers.fetch,
			loadNextPage: handlers.loadNextPage,
		}
	}
}

export type FragmentStorePaginated<_Data extends GraphQLObject, _Input> = Readable<{
	data: _Data
	fetching: boolean
	pageInfo: PageInfo
}> & {
	loadNextPage(
		pageCount?: number,
		after?: string | number,
		houdiniContext?: HoudiniFetchContext
	): Promise<void>
	loadPreviousPage(
		pageCount?: number,
		before?: string,
		houdiniContext?: HoudiniFetchContext
	): Promise<void>
}

export type FragmentPaginatedResult<_Data, _ExtraFields = {}> = {
	data: _Data | null
	fetching: boolean
} & _ExtraFields
