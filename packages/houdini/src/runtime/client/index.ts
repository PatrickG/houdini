/// <reference path="../../../../../houdini.d.ts" />
import { GraphQLObject, DocumentArtifact } from '../lib/types'
import { ClientPlugin, DocumentObserver } from './documentObserver'
import pluginsFromPlugins from './injectedPlugins'
import {
	queryPlugin,
	mutationPlugin,
	fetchPlugin,
	fetchParamsPlugin,
	inputsPlugin,
	type FetchParamFn,
} from './plugins'

// export the plugin constructors
export { queryPlugin, mutationPlugin, fetchPlugin, subscriptionPlugin } from './plugins'

type ConstructorArgs = {
	url: string
	fetchParams?: FetchParamFn
	plugins?: ClientPlugin[]
	pipeline?: () => ClientPlugin[]
}

export class HoudiniClient {
	// the URL of the api
	url: string

	// the list of plugins for the client
	#plugins: ClientPlugin[]

	constructor(args: {
		url: string
		fetchParams?: FetchParamFn
		plugins?: ClientPlugin[]
		pipeline?: never
	})
	constructor(args: {
		url: string
		fetchParams?: FetchParamFn
		plugins?: never
		pipeline?: () => ClientPlugin[]
	})
	constructor({ url, fetchParams, plugins, pipeline }: ConstructorArgs) {
		// if we were given plugins and pipeline there's an error
		if (plugins && pipeline) {
			throw new Error(
				'A client cannot be given a pipeline and a list of plugins at the same time.'
			)
		}

		// a few middlewares _have_ to run to setup the pipeline
		this.#plugins = [inputsPlugin].concat(
			fetchParams ? [fetchParamsPlugin(fetchParams)] : [],
			// if the user wants to specify the entire pipeline, let them do so
			pipeline?.() ??
				// the user doesn't have a specific pipeline so we should just add their desired plugins
				// to the standard set
				[
					// make sure that queries and mutations always work
					queryPlugin,
					mutationPlugin,
				].concat(
					// add the specified middlewares
					plugins ?? [],
					// and any middlewares we got from plugins
					pluginsFromPlugins,
					// if they provided a fetch function, use it as the body for the fetch middleware
					fetchPlugin()
				)
		)

		// save the state values
		this.url = url
	}

	observe({
		artifact,
		cache = true,
	}: {
		artifact: DocumentArtifact
		cache?: boolean
	}): DocumentObserver<GraphQLObject, {}> {
		return new DocumentObserver({ client: this, artifact, plugins: this.#plugins, cache })
	}
}
