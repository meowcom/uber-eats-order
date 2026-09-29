const ALLOWED_HOSTNAMES = new Set([
  "ubereats.com",
  "www.ubereats.com"
]);


function json(data, status = 200){

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers:{
        "Content-Type":"application/json; charset=UTF-8",
        "Cache-Control":"no-store"
      }
    }
  );

}


function isUberEatsUrl(value){

  try{

    const url = new URL(value);

    if(
      !["https:","http:"].includes(
        url.protocol
      )
    ){
      return false;
    }

    return (
      url.hostname === "ubereats.com" ||
      url.hostname.endsWith(".ubereats.com")
    );

  }catch{

    return false;

  }

}


async function getRenderedHtml(
  env,
  targetUrl
){

  if(!env.BROWSER){

    throw new Error(
      "Cloudflare Browser Run 尚未設定。請先建立 BROWSER binding。"
    );

  }


  const response =
    await env.BROWSER.quickAction(
      "content",
      {
        url:targetUrl.toString(),

        gotoOptions:{
          waitUntil:"networkidle2",
          timeout:30000
        }
      }
    );


  if(!response.ok){

    const detail =
      await response.text();

    throw new Error(
      "Browser Run 錯誤：" +
      response.status +
      " " +
      detail.slice(0,500)
    );

  }


  const data =
    await response.json();


  if(
    !data.success ||
    typeof data.result !== "string"
  ){

    throw new Error(
      "Browser Run 沒有回傳有效 HTML"
    );

  }


  return data.result;

}


/* ================================
   HTML 工具
================================ */

function decodeHtml(str){

  if(!str)
    return "";

  return str
    .replace(/&amp;/g,"&")
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/\\u0026/g,"&")
    .replace(/\\u003c/g,"<")
    .replace(/\\u003e/g,">")
    .replace(/\\u0022/g,'"')
    .replace(/\\u0027/g,"'");

}


function stripHtml(str){

  return decodeHtml(
    String(str || "")
      .replace(/<script[\s\S]*?<\/script>/gi,"")
      .replace(/<style[\s\S]*?<\/style>/gi,"")
      .replace(/<[^>]+>/g," ")
      .replace(/\s+/g," ")
      .trim()
  );

}


function cleanText(str){

  return String(
    stripHtml(str)
  )
    .replace(/\s+/g," ")
    .trim();

}


function numberFromPrice(value){

  if(
    value === null ||
    value === undefined
  ){
    return null;
  }


  if(typeof value === "number")
    return value;


  const text =
    String(value)
      .replace(/,/g,"")
      .replace(/[^\d.]/g,"");


  if(!text)
    return null;


  const number =
    Number(text);


  return Number.isFinite(number)
    ? number
    : null;

}


/* ================================
   JSON-LD
================================ */

function extractJsonLd(html){

  const results=[];

  const regex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;


  let match;


  while(
    (match=regex.exec(html))
  ){

    try{

      const parsed =
        JSON.parse(
          match[1].trim()
        );

      if(Array.isArray(parsed)){

        results.push(...parsed);

      }else{

        results.push(parsed);

      }

    }catch{

      // ignore invalid JSON-LD

    }

  }


  return results;

}


/* ================================
   找所有 JSON Script
================================ */

function extractScriptJson(html){

  const results=[];

  const regex =
    /<script[^>]*>([\s\S]*?)<\/script>/gi;


  let match;


  while(
    (match=regex.exec(html))
  ){

    const content =
      match[1].trim();


    if(
      content.length < 20 ||
      content.length > 5000000
    ){

      continue;

    }


    if(
      content.includes('"restaurant"') ||
      content.includes('"menu"') ||
      content.includes('"sections"') ||
      content.includes('"items"') ||
      content.includes('"catalog"')
    ){

      results.push(content);

    }

  }


  return results;

}


/* ================================
   深度搜尋物件
================================ */

function walkObject(
  value,
  callback,
  seen=new Set()
){

  if(
    !value ||
    typeof value !== "object"
  ){

    return;

  }


  if(seen.has(value))
    return;


  seen.add(value);


  callback(value);


  if(Array.isArray(value)){

    for(const item of value){

      walkObject(
        item,
        callback,
        seen
      );

    }

  }else{

    for(const key of Object.keys(value)){

      walkObject(
        value[key],
        callback,
        seen
      );

    }

  }

}


/* ================================
   JSON 字串嘗試解析
================================ */

function tryParseJson(text){

  if(!text)
    return null;


  let cleaned =
    text
      .replace(/^\s*<!--/,"")
      .replace(/-->\s*$/,"")
      .trim();


  try{

    return JSON.parse(cleaned);

  }catch{}


  /*
   * 嘗試尋找第一個 { 到最後一個 }
   */

  const start =
    cleaned.indexOf("{");

  const end =
    cleaned.lastIndexOf("}");


  if(
    start>=0 &&
    end>start
  ){

    try{

      return JSON.parse(
        cleaned.slice(start,end+1)
      );

    }catch{}

  }


  return null;

}


/* ================================
   嘗試找到商品陣列
================================ */

function findItemArrays(root){

  const arrays=[];


  walkObject(
    root,
    obj=>{

      for(
        const key of Object.keys(obj)
      ){

        const value =
          obj[key];


        if(
          !Array.isArray(value) ||
          !value.length
        ){

          continue;

        }


        const sample =
          value.find(
            x =>
              x &&
              typeof x === "object"
          );


        if(!sample)
          continue;


        const keys =
          Object.keys(sample)
            .map(x=>x.toLowerCase());


        const looksLikeItem =
          keys.some(k =>
            [
              "price",
              "title",
              "name",
              "description",
              "item",
              "product",
              "uuid",
              "image"
            ].some(
              hint => k.includes(hint)
            )
          );


        if(looksLikeItem){

          arrays.push(value);

        }

      }

    }
  );


  return arrays;

}


/* ================================
   商品解析
================================ */

function parseItem(raw){

  if(
    !raw ||
    typeof raw !== "object"
  ){

    return null;

  }


  const name =
    cleanText(
      raw.title ??
      raw.name ??
      raw.displayName ??
      raw.itemName ??
      raw.productName ??
      raw.localizedName ??
      ""
    );


  if(!name)
    return null;


  let price =
    numberFromPrice(
      raw.price ??
      raw.priceValue ??
      raw.basePrice ??
      raw.displayPrice ??
      raw.amount ??
      raw.cost
    );


  /*
   * 有些資料會是：
   *
   * price: {
   *   amount: 100
   * }
   */

  if(
    price === null &&
    raw.price &&
    typeof raw.price === "object"
  ){

    price =
      numberFromPrice(
        raw.price.amount ??
        raw.price.value ??
        raw.price.price
      );

  }


  const description =
    cleanText(
      raw.description ??
      raw.subtitle ??
      raw.shortDescription ??
      ""
    );


  const image =
    raw.imageUrl ??
    raw.image ??
    raw.pictureUrl ??
    raw.thumbnailUrl ??
    raw.image?.url ??
    null;


  const modifierGroups =
    parseModifiers(raw);


  return {

    id:
      String(
        raw.id ??
        raw.uuid ??
        raw.itemId ??
        crypto.randomUUID()
      ),

    name,

    description,

    price,

    image,

    modifierGroups

  };

}


/* ================================
   客製化
================================ */

function parseModifiers(raw){

  const groups=[];


  const candidates=[

    raw.modifierGroups,

    raw.modifiers,

    raw.options,

    raw.customizations,

    raw.customizationGroups,

    raw.choiceGroups,

    raw.variationGroups

  ];


  for(
    const candidate of candidates
  ){

    if(!Array.isArray(candidate))
      continue;


    for(
      const group of candidate
    ){

      if(
        !group ||
        typeof group !== "object"
      ){

        continue;

      }


      const groupName =
        cleanText(
          group.title ??
          group.name ??
          group.displayName ??
          group.label ??
          "客製化"
        );


      const optionsSource =
        group.options ??
        group.items ??
        group.modifiers ??
        group.choices ??
        [];


      if(
        !Array.isArray(optionsSource) ||
        !optionsSource.length
      ){

        continue;

      }


      const options=[];


      for(
        const option of optionsSource
      ){

        if(
          !option ||
          typeof option !== "object"
        ){

          continue;

        }


        const name =
          cleanText(
            option.name ??
            option.title ??
            option.displayName ??
            option.label ??
            ""
          );


        if(!name)
          continue;


        const price =
          numberFromPrice(
            option.price ??
            option.priceValue ??
            option.amount ??
            option.additionalPrice
          ) || 0;


        options.push({

          name,

          price

        });

      }


      if(options.length){

        groups.push({

          name:groupName,

          multiple:
            Boolean(
              group.multiple ??
              group.multiSelect ??
              group.allowMultiple
            ),

          options

        });

      }

    }

  }


  return groups;

}


/* ================================
   JSON 全面解析
================================ */

function parseJsonSources(
  html
){

  const objects=[];


  /*
   * JSON-LD
   */

  for(
    const data of extractJsonLd(html)
  ){

    objects.push(data);

  }


  /*
   * Script JSON
   */

  for(
    const text of extractScriptJson(html)
  ){

    const data =
      tryParseJson(text);


    if(data){

      objects.push(data);

    }

  }


  return objects;

}


/* ================================
   從資料中建立餐廳
================================ */

function normalizeRestaurant(
  html,
  jsonSources
){

  let restaurantName="";
  let restaurantDescription="";
  let restaurantImage=null;


  /*
   * JSON-LD 優先
   */

  for(
    const data of jsonSources
  ){

    walkObject(
      data,
      obj=>{

        if(!restaurantName){

          const candidate =
            obj.name;

          if(
            typeof candidate === "string" &&
            candidate.length < 150
          ){

            const type =
              String(
                obj["@type"] || ""
              ).toLowerCase();


            if(
              type.includes("restaurant") ||
              type.includes("food") ||
              type.includes("localbusiness")
            ){

              restaurantName =
                cleanText(candidate);

            }

          }

        }


        if(
          !restaurantDescription &&
          typeof obj.description === "string"
        ){

          restaurantDescription =
            cleanText(
              obj.description
            );

        }


        if(
          !restaurantImage &&
          typeof obj.image === "string"
        ){

          restaurantImage =
            obj.image;

        }

      }
    );

  }


  /*
   * HTML title fallback
   */

  if(!restaurantName){

    const titleMatch =
      html.match(
        /<title[^>]*>([\s\S]*?)<\/title>/i
      );


    if(titleMatch){

      restaurantName =
        cleanText(
          titleMatch[1]
            .replace(/\|\s*Uber Eats.*$/i,"")
        );

    }

  }


  /*
   * 找商品陣列
   */

  const arrays=[];


  for(
    const root of jsonSources
  ){

    arrays.push(
      ...findItemArrays(root)
    );

  }


  /*
   * 去重商品
   */

  const itemMap =
    new Map();


  for(
    const array of arrays
  ){

    for(
      const raw of array
    ){

      const item =
        parseItem(raw);


      if(!item)
        continue;


      const key =
        (
          item.name +
          "|" +
          (
            item.price ?? ""
          )
        )
        .toLowerCase();


      if(!itemMap.has(key)){

        itemMap.set(
          key,
          item
        );

      }

    }

  }


  const allItems =
    [...itemMap.values()];


  /*
   * 嘗試從資料結構中尋找分類
   */

  const categories=[];


  for(
    const root of jsonSources
  ){

    walkObject(
      root,
      obj=>{

        for(
          const key of Object.keys(obj)
        ){

          const value =
            obj[key];


          if(
            !Array.isArray(value) ||
            !value.length
          ){

            continue;

          }


          const looksLikeCategoryArray =
            value.some(
              x =>
                x &&
                typeof x === "object" &&
                (
                  x.categoryItems ||
                  x.items ||
                  x.menuItems ||
                  x.products
                )
            );


          if(!looksLikeCategoryArray)
            continue;


          for(
            const cat of value
          ){

            if(
              !cat ||
              typeof cat !== "object"
            ){

              continue;

            }


            const categoryName =
              cleanText(
                cat.title ??
                cat.name ??
                cat.displayName ??
                cat.label ??
                ""
              );


            const rawItems =
              cat.items ??
              cat.menuItems ??
              cat.products ??
              cat.categoryItems ??
              [];


            if(
              !categoryName ||
              !Array.isArray(rawItems)
            ){

              continue;

            }


            const categoryItems=[];


            for(
              const rawItem of rawItems
            ){

              const item =
                parseItem(
                  rawItem?.item ??
                  rawItem?.product ??
                  rawItem
                );


              if(item){

                categoryItems.push(item);

              }

            }


            if(categoryItems.length){

              categories.push({

                name:categoryName,

                items:categoryItems

              });

            }

          }

        }

      }
    );

  }


  /*
   * 分類解析失敗時，
   * 至少把所有商品放進「全部商品」
   */

  if(!categories.length){

    categories.push({

      name:"全部商品",

      items:allItems

    });

  }


  /*
   * 分類去重
   */

  const categoryMap =
    new Map();


  for(
    const category of categories
  ){

    const key =
      category.name.toLowerCase();


    if(
      !categoryMap.has(key)
    ){

      categoryMap.set(
        key,
        {
          name:category.name,
          items:[]
        }
      );

    }


    const target =
      categoryMap.get(key);


    for(
      const item of category.items
    ){

      const exists =
        target.items.some(
          x =>
            x.name === item.name &&
            x.price === item.price
        );


      if(!exists){

        target.items.push(item);

      }

    }

  }


  const finalCategories =
    [...categoryMap.values()];


  /*
   * 如果分類裡沒有東西，
   * 使用全部商品
   */

  const finalCount =
    finalCategories.reduce(
      (sum,x)=>
        sum+x.items.length,
      0
    );


  if(
    finalCount === 0 &&
    allItems.length
  ){

    finalCategories.length=0;

    finalCategories.push({

      name:"全部商品",

      items:allItems

    });

  }


  return {

    name:
      restaurantName ||
      "Uber Eats 餐廳",

    description:
      restaurantDescription,

    image:
      restaurantImage,

    categories:
      finalCategories

  };

}


/* ================================
   主 API
================================ */

export async function onRequestPost(
  context
){

  try{

    const body =
      await context.request.json();


    const inputUrl =
      String(
        body?.url || ""
      ).trim();


    if(!inputUrl){

      return json(
        {
          success:false,
          error:"缺少餐廳網址"
        },
        400
      );

    }


    if(!isUberEatsUrl(inputUrl)){

      return json(
        {
          success:false,
          error:"只允許 Uber Eats 網址"
        },
        400
      );

    }


    const targetUrl =
      new URL(inputUrl);


    /*
     * 使用 Cloudflare Browser Run
     */

    const html =
      await getRenderedHtml(
        context.env,
        targetUrl
      );


    if(
      !html ||
      html.length < 500
    ){

      return json(
        {
          success:false,
          error:
            "Uber Eats 頁面沒有取得有效內容"
        },
        502
      );

    }


    /*
     * 偵測是否遇到驗證 / 阻擋頁
     */

    const lower =
      html.toLowerCase();


    const blockWords=[

      "verify you are human",

      "checking your browser",

      "access denied",

      "unusual traffic",

      "captcha"

    ];


    const blocked =
      blockWords.some(
        word =>
          lower.includes(word)
      );


    if(blocked){

      return json(
        {
          success:false,

          error:
            "Uber Eats 回傳驗證或阻擋頁面，Browser Run 目前無法取得菜單。"

        },
        403
      );

    }


    /*
     * 解析
     */

    const jsonSources =
      parseJsonSources(html);


    const restaurant =
      normalizeRestaurant(
        html,
        jsonSources
      );


    const itemCount =
      restaurant.categories.reduce(
        (sum,category)=>
          sum +
          (
            category.items?.length || 0
          ),
        0
      );


    if(itemCount===0){

      return json(
        {
          success:false,

          error:
            "頁面有成功載入，但目前沒有解析到商品資料。Uber Eats 的資料結構可能已更新，需要調整解析器。",

          debug:{
            htmlLength:html.length,
            jsonSourceCount:
              jsonSources.length
          }

        },
        422
      );

    }


    return json({

      success:true,

      restaurant,

      meta:{

        itemCount,

        categoryCount:
          restaurant.categories.length

      }

    });


  }catch(error){

    console.error(error);


    return json(
      {
        success:false,

        error:
          error?.message ||
          "伺服器發生未知錯誤"

      },
      500
    );

  }

}


/*
 * 也允許 OPTIONS
 */

export async function onRequestOptions(){

  return new Response(
    null,
    {
      status:204,
      headers:{
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Methods":
          "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type"
      }
    }
  );

}
