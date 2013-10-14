FROM samcday/ruby-1.8:latest
MAINTAINER Sam Day, me@samcday.com.au

RUN apt-get install -y libsqlite3-dev
RUN gem install --no-rdoc --no-ri mailcatcher

EXPOSE 25
EXPOSE 80
ENTRYPOINT ["mailcatcher", "-f", "--smtp-port", "25", "--http-port", "80", "--http-ip", "0.0.0.0", "--smtp-ip", "0.0.0.0"]
