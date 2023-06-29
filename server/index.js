import cors from 'cors'
import { z } from 'zod'
import dotenv from 'dotenv'
import helmet from 'helmet'
import morgan from 'morgan'
import express from 'express'
import { nanoid } from 'nanoid'
import { createClient } from '@vercel/kv'

dotenv.config()

// Global consts
const PORT = process.env.PORT || 8000
const ENV = process.env.NODE_ENV || 'development'
const DOMAIN = process.env.DOMAIN || `localhost:${PORT}`

class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
    this.status = 400
  }
}

class DatabaseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DatabaseError'
    this.status = 503
  }
}

// Express app
const app = express()

const url = process.env.KV_REST_API_URL
const token = process.env.KV_REST_API_TOKEN
const kv = createClient({ url, token })

app.use(helmet())
app.use(morgan('tiny'))
app.use(cors())
app.use(express.json())
app.use(express.static('./public'))

const schema = z.object({
  slug: z
    .string()
    .min(1, { message: 'Slug must be at least 1 character long.' })
    .max(255, { message: 'Slug must be less than 255 characters long.' })
    .regex(/^[\w\-]+$/i, {
      message: 'This slug uses characters that are not allowed.',
    })
    .transform((slug) => slug.toLowerCase())
    .optional(),
  url: z
    .string({
      required_error:
        'A URL is required to create a short link. Please supply a URL to shorten.',
    })
    .url(),
})

app.get('/url/:id', async (req, res, next) => {
  const { id: slug } = req.params

  try {
    const urlData = await kv.get(slug)

    // If there's no matching slug in the database, send a 404 response
    if (!urlData) {
      return res.status(404).json({ error: 'URL not found' })
    }

    // If the URL was found, return it as JSON
    return res.json({ url: urlData.url })
  } catch (error) {
    // Forward any errors to the error handler
    if (error.message.includes('kv')) {
      // database error
      next(
        new DatabaseError('Service temporarily unavailable, please try again.')
      )
    } else {
      // other types of errors
      next(error)
    }
  }
})

app.get('/:id', async (req, res, next) => {
  const { id: slug } = req.params

  try {
    let urlData = await kv.get(slug)

    // If there's no matching slug in the database, send a 404 response
    if (!urlData) {
      return res.status(404).json({ error: 'URL not found' })
    }

    // Increment the clicks count
    if (urlData?.clicks >= 0) {
      urlData.clicks += 1
      await kv.set(slug, urlData)
    }
    await kv.set(slug, urlData)

    // If the URL was found, redirect to it
    return res.redirect(urlData.url)
  } catch (error) {
    if (error.message.includes('kv')) {
      // Database error
      next(
        new DatabaseError('Service temporarily unavailable, please try again.')
      )
    } else {
      // Other types of errors
      next(error)
    }
  }
})

app.post('/url', async (req, res, next) => {
  try {
    let { slug, url } = req.body

    const generateSlug = async () => {
      let slugIsUnique = false
      while (!slugIsUnique) {
        slug = nanoid(5).toLowerCase()
        const existing = await kv.get(slug)
        console.log(existing) // curious
        if (!existing) slugIsUnique = true
      }
      return slug
    }

    // Generates a new slug if one is not provided or formats the one provided.
    if (!slug) {
      slug = await generateSlug()
    } else {
      slug = slug.toLowerCase()
    }

    // Checks if the slug is already in use.
    const existing = await kv.get(slug)
    if (existing) {
      throw new Error('Slug in use. 🐌')
    }

    schema.parse({
      slug,
      url,
    })

    const newUrl = {
      url,
      slug,
      secret: nanoid(10),
      clicks: 0,
    }
    await kv.set(slug, newUrl)
    res.status(201).json({
      message: 'URL has been shortened successfully!',
      slug: newUrl.slug,
      shortURL: `${ENV === 'production' ? 'https' : 'http'}://${DOMAIN}/${
        newUrl.slug
      }`,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      // validation error
      next(new ValidationError(error.message))
    } else if (error.message === 'Slug in use. 🐌') {
      // slug is already in use
      next(new ValidationError(error.message))
    } else if (error.message.includes('kv')) {
      // database error
      next(
        new DatabaseError('Service temporarily unavailable, please try again.')
      )
    } else {
      // other types of errors
      next(error)
    }
  }
})

// Error handler
app.use((error, req, res, next) => {
  if (error instanceof ValidationError || error instanceof DatabaseError) {
    res.status(error.status)
  } else {
    res.status(500)
  }
  res.json({
    message: error.message,
    stack: ENV === 'production' ? undefined : error.stack,
  })
})

app.listen(PORT, () => {
  console.log(`Listening at http://localhost:${PORT}`)
})
