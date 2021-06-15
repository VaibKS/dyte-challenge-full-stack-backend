import { Request, Response } from 'express';
import { MongoError } from 'mongodb';
import { Types } from 'mongoose';
import { pick } from 'lodash';
import { getRandomHash } from '../utils/hash';

import LinkModel, { Link } from './models';
import VisitModel from '../visit/models';
// import { PaginateResult } from 'mongoose';

const addRandomHashLink = (
  uid: string,
  url: string,
  res: Response,
  iteration: number
) => {
  if (iteration > 5) {
    res.status(500);
    return res.send('Unknown error');
  }
  const hash = getRandomHash();
  console.log(uid, url, hash);
  linkAdder(uid, url, hash)
    .then((link: Link) => {
      res.status(200);
      res.send(hash);
    })
    .catch((error: Error) => {
      // console.log(error);
      addRandomHashLink(uid, url, res, iteration + 1);
    });
};

const linkAdder = (uid: string, url: string, hash: string) => {
  // prepend https:// if url doesn't start with https?://
  const link = new LinkModel({
    uid,
    hash,
    url: !/^https?:\/\//.test(url) ? `https://${url}` : url,
  });
  return link.save();
};

export const addLink = (req: Request, res: Response) => {
  const { user } = res.locals;

  if (!user) {
    res.status(401);
    return res.send();
  }

  const linkData = req.body;

  if (!('url' in linkData) || linkData.url.length === 0) {
    res.status(400);
    return res.send('No URL');
  }

  if ('hash' in linkData) {
    if (linkData.hash.length < 4) {
      res.send(400);
      return res.send('Short hash');
    }

    const hash: string = linkData.hash;

    linkAdder(user.id, linkData.url, hash)
      .then((link: Link) => {
        res.status(200);
        res.send(hash);
      })
      .catch((error: Error) => {
        if (error instanceof MongoError) {
          res.status(409);
          res.send('Hash in use');
        } else {
          res.status(500);
          res.send('Unknown error');
        }
      });
  } else {
    addRandomHashLink(user.id, linkData.url, res, 1);
  }
};

const getLinkWithStats = (res: Response, link: Link, userId: string) => {
  const promises = Promise.all([
    // Get unique views
    VisitModel.aggregate([
      {
        $match: {
          lid: link._id,
        },
      },
      {
        $group: {
          _id: '$ipAddress',
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
        },
      },
    ]),
    // VisitModel.aggregate([
    //   {
    //     $group: {
    //       _id: '$ipAddress',
    //       count: { $sum: 1 },
    //     },
    //   },
    //   { $count: 'documentCount' },
    // ]),
    // alternative
    // VisitModel.find({ lid: link._id }).distinct('ipAddress'),

    // Get total views
    LinkModel.aggregate([
      {
        $match: { hash: link.hash, uid: userId },
      },
      {
        $lookup: {
          from: 'visits',
          localField: '_id',
          foreignField: 'lid',
          as: 'visits',
        },
      },
      {
        $project: {
          hash: 1,
          count: { $size: '$visits' },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$count' },
        },
      },
    ]),
    //alterative
    // VisitModel.find({ lid: link._id }).countDocuments(),

    // Get browser stats
    // VisitModel.aggregate([
    //   {
    //     $group: {
    //       _id: '$browser',
    //       count: { $sum: 1 },
    //     },
    //   },
    // ]),
    VisitModel.aggregate([
      {
        $match: {
          lid: link._id,
        },
      },
      {
        $group: {
          _id: '$browser',
          count: { $sum: 1 },
        },
      },
    ]),

    // Get OS stats
    // VisitModel.aggregate([
    //   {
    //     $group: {
    //       _id: '$os',
    //       count: { $sum: 1 },
    //     },
    //   },
    // ]),
    VisitModel.aggregate([
      {
        $match: {
          lid: link._id,
        },
      },
      {
        $group: {
          _id: '$os',
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  promises
    .then(([uniqueViews, totalViews, browserResults, osResults]) => {
      const browsers: Record<string, number> = {},
        os: Record<string, number> = {};

      for (const row of browserResults) {
        browsers[row._id] = row.count;
      }

      for (const row of osResults) {
        os[row._id] = row.count;
      }

      res.status(200);
      res.json({
        ...pick(link, ['url', 'createdAt']),
        uniqueViews: uniqueViews.length === 0 ? 0 : uniqueViews[0].total,
        totalViews: totalViews.length === 0 ? 0 : totalViews[0].total,
        browsers,
        os,
      });
    })
    .catch((err: Error) => {
      res.status(500);
      res.send('Unknown error');
    });
};

export const getLink = (req: Request, res: Response) => {
  const { user } = res.locals;

  if (!user) {
    res.status(401);
    return res.send();
  }

  const hash = req.params.hash;

  LinkModel.findOne({ hash, uid: user.id })
    .lean()
    .then((link: Link) => {
      if (!link) {
        res.status(404);
        return res.send('Not found');
      }
      getLinkWithStats(res, link, user.id);
    })
    .catch((error: Error) => {
      res.status(500);
      res.send('Unknown error');
    });
};

export const getAllLinks = (req: Request, res: Response) => {
  const { user } = res.locals;

  if (!user) {
    res.status(401);
    return res.send();
  }

  let page: number = 1;
  const batchSize = 10;

  try {
    page = Number(req.query.page) ?? 1;
  } catch (e) {}

  if (!page) page = 1;

  // pagination
  Promise.all([
    LinkModel.find({ uid: user.id }).countDocuments(),
    LinkModel.find({ uid: user.id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * batchSize)
      .limit(batchSize)
      .lean(),
  ])
    .then(([totalCount, links]) => {
      const pages = Math.ceil(totalCount / batchSize);

      res.json({
        links: links.map((link: Link) => pick(link, ['hash', 'url'])),
        hasNextPage: page < pages ? true : false,
        page,
        total: totalCount,
        pages,
      });
    })
    .catch((error: Error) => {
      res.status(500);
      res.send('Unknown error');
    });
};

export const getStats = (req: Request, res: Response) => {
  const { user } = res.locals;
  if (!user) {
    res.status(401);
    return res.send();
  }
  console.log(user);
  LinkModel.aggregate([
    {
      $match: { uid: user.id },
    },
    {
      $lookup: {
        from: 'visits',
        localField: '_id',
        foreignField: 'lid',
        as: 'visits',
      },
    },
    {
      $project: {
        hash: 1,
        count: { $size: '$visits' },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$count' },
      },
    },
  ])
    .then((stats) => {
      console.log(stats);
      const totalViews = stats.length === 0 ? 0 : stats[0].total;
      res.status(200);
      res.json({
        totalViews,
      });
    })
    .catch((error: Error) => {
      console.log(error);
      res.status(500);
      res.send('Unknown error');
    });
};

export const deleteLink = (req: Request, res: Response) => {
  const { user } = res.locals;
  if (!user) {
    res.status(401);
    return res.send();
  }

  const hash = req.params.hash;

  LinkModel.deleteOne({ hash, uid: user.id })
    .then((result: { deletedCount?: number }) => {
      if (result.deletedCount == 0) {
        res.status(404);
        res.send('Not found');
      } else {
        res.status(200);
        res.send('Deleted');
      }
    })
    .catch((e: Error) => {
      res.status(500);
      res.send('Unknown error');
    });
};

const getValidURL = (url: string): string => {
  if (!/^https?:\/\//.test(url)) {
    return `https://${url}`;
  }
  return url;
};

export const patchLink = (req: Request, res: Response) => {
  const { user } = res.locals;
  if (!user) {
    res.status(401);
    return res.send();
  }

  const hash = req.params.hash;

  const linkUpdate = pick(req.body, ['hash', 'url']);
  if ('url' in linkUpdate) {
    linkUpdate.url = getValidURL(linkUpdate.url);
  }

  LinkModel.updateOne({ hash, uid: user.id }, linkUpdate)
    .then((n: Record<string, number>) => {
      res.status(200);
      res.send('Patched');
    })
    .catch((e: Error) => {
      res.status(500);
      res.send('Unknown error');
    });
};
