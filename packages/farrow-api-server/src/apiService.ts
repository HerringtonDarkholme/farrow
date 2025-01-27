import { Router, Response, RouterPipeline } from 'farrow-http'
import { List, SchemaCtor, SchemaCtorInput, Struct, toSchemaCtor, Any } from 'farrow-schema'
import { ApiDefinition, ApiEntries, getContentType, isApi } from 'farrow-api'
import { FormatResult, toJSON } from 'farrow-api/dist/toJSON'
import { createSchemaValidator, ValidationError, Validator } from 'farrow-schema/validator'
import get from 'lodash.get'
import { ApiError, ApiSuccess } from './apiResponse'

export type ApiServiceType = RouterPipeline

const BodySchema = Struct({
  path: List(String),
  input: Any,
})

const validateBody = createSchemaValidator(BodySchema)

const getErrorMessage = (error: ValidationError) => {
  let { message } = error

  if (Array.isArray(error.path) && error.path.length > 0) {
    message = `path: ${JSON.stringify(error.path)}\n${message}`
  }

  return message
}

export type CreateApiServiceOptions = {
  entries: ApiEntries
  errorStack?: boolean
}

export const createApiService = (options: CreateApiServiceOptions): ApiServiceType => {
  let isNotProduction = process.env.NODE_ENV !== 'production'
  let config = {
    errorStack: isNotProduction,
    ...options,
  }
  let { entries } = options

  let router = Router()

  let validatorMap = new WeakMap<SchemaCtor, Validator>()

  let getValidator = (Schema: SchemaCtor) => {
    if (validatorMap.has(Schema)) {
      return validatorMap.get(Schema)!
    }
    let validator = createSchemaValidator(Schema)
    validatorMap.set(Schema, validator)
    return validator
  }

  let formatResult: FormatResult | undefined

  router.use(async (request, next) => {
    if (request.method?.toLowerCase() !== 'post') {
      return next()
    }

    /**
     * capture introspection request
     */
    if (request.body?.input?.__introspection__ === true) {
      let output = (formatResult = formatResult ?? toJSON(entries))
      return Response.json(ApiSuccess(output))
    }

    let bodyResult = validateBody(request.body)

    if (bodyResult.isErr) {
      let message = getErrorMessage(bodyResult.value)
      return Response.json(ApiError(message))
    }

    let api = get(entries, bodyResult.value.path)

    if (!isApi(api)) {
      let message = `The target API was not found with the path: [${bodyResult.value.path.join(', ')}]`
      return Response.json(ApiError(message))
    }

    let definition = api.definition as ApiDefinition<SchemaCtorInput>

    let InputSchema = toSchemaCtor(getContentType(definition.input))
    let validateApiInput = getValidator(InputSchema)

    /**
     * validate input
     */
    let inputResult = validateApiInput(bodyResult.value.input)

    if (inputResult.isErr) {
      let message = getErrorMessage(inputResult.value)
      return Response.json(ApiError(message))
    }

    try {
      let output = await api(inputResult.value)

      let OutputSchema = toSchemaCtor(getContentType(definition.output))
      let validateApiOutput = getValidator(OutputSchema)

      /**
       * validate output
       */
      let outputResult = validateApiOutput(output)

      if (outputResult.isErr) {
        let message = getErrorMessage(outputResult.value)
        return Response.json(ApiError(message))
      }

      /**
       * response output
       */
      return Response.json(ApiSuccess(outputResult.value))
    } catch (error) {
      let message = (config.errorStack ? error?.stack || error?.message : error?.message) ?? ''
      return Response.json(ApiError(message))
    }
  })

  return router
}

export const ApiService = createApiService
